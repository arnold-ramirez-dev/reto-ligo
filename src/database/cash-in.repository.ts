import { Injectable, Inject } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Pool, PoolClient, QueryResultRow } from "pg";
import { PG_POOL } from "./tokens";

export type CashInStatus =
  "PENDING" | "PROCESSING" | "UNKNOWN" | "COMPLETED" | "FAILED";

export interface CashInOperation extends QueryResultRow {
  id: string;
  idempotency_key: string;
  request_hash: string;
  user_id: string;
  amount_minor: string;
  currency: string;
  payment_method: string;
  status: CashInStatus;
  provider_payment_id: string | null;
  failure_code: string | null;
  failure_reason: string | null;
  new_balance_minor: string | null;
  provider_attempts: number;
  processing_lease_until: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateOperationInput {
  id: string;
  idempotencyKey: string;
  requestHash: string;
  userId: string;
  amountMinor: number;
  currency: string;
  paymentMethod: string;
}

export interface ClaimResult {
  claimed: boolean;
  operation: CashInOperation;
}

@Injectable()
export class CashInRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async createOrGet(
    input: CreateOperationInput,
  ): Promise<{ created: boolean; operation: CashInOperation }> {
    const inserted = await this.pool.query<CashInOperation>(
      `INSERT INTO cash_in_operations
       (id, idempotency_key, request_hash, user_id, amount_minor, currency, payment_method)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
      [
        input.id,
        input.idempotencyKey,
        input.requestHash,
        input.userId,
        input.amountMinor,
        input.currency,
        input.paymentMethod,
      ],
    );
    if (inserted.rowCount === 1)
      return { created: true, operation: inserted.rows[0] };
    const existing = await this.getByIdempotencyKey(input.idempotencyKey);
    if (!existing)
      throw new Error("Operation disappeared after idempotency conflict");
    return { created: false, operation: existing };
  }

  async getById(id: string): Promise<CashInOperation | undefined> {
    const result = await this.pool.query<CashInOperation>(
      "SELECT * FROM cash_in_operations WHERE id = $1",
      [id],
    );
    return result.rows[0];
  }

  async getByIdempotencyKey(key: string): Promise<CashInOperation | undefined> {
    const result = await this.pool.query<CashInOperation>(
      "SELECT * FROM cash_in_operations WHERE idempotency_key = $1",
      [key],
    );
    return result.rows[0];
  }

  async claimForProcessing(operationId: string): Promise<ClaimResult> {
    return this.transaction(async (client) => {
      const operation = await this.lockOperation(client, operationId);
      if (operation.status === "COMPLETED" || operation.status === "FAILED")
        return { claimed: false, operation };
      const isLeaseActive =
        operation.status === "PROCESSING" &&
        operation.processing_lease_until !== null &&
        operation.processing_lease_until.getTime() > Date.now();
      if (isLeaseActive) return { claimed: false, operation };
      const result = await client.query<CashInOperation>(
        `UPDATE cash_in_operations
         SET status = 'PROCESSING', provider_attempts = provider_attempts + 1,
             processing_lease_until = NOW() + INTERVAL '30 seconds', updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [operationId],
      );
      return { claimed: true, operation: result.rows[0] };
    });
  }

  async markUnknown(operationId: string): Promise<CashInOperation> {
    const result = await this.pool.query<CashInOperation>(
      `UPDATE cash_in_operations
       SET status = 'UNKNOWN', processing_lease_until = NULL, updated_at = NOW()
       WHERE id = $1 AND status = 'PROCESSING'
       RETURNING *`,
      [operationId],
    );
    return result.rows[0] ?? (await this.mustGet(operationId));
  }

  async complete(
    operationId: string,
    providerPaymentId: string,
  ): Promise<CashInOperation> {
    return this.transaction((client) =>
      this.completeInTransaction(client, operationId, providerPaymentId),
    );
  }

  async fail(
    operationId: string,
    code: string,
    reason: string,
  ): Promise<CashInOperation> {
    return this.transaction((client) =>
      this.failInTransaction(client, operationId, code, reason),
    );
  }

  async receiveWebhook(input: {
    providerEventId: string;
    operationId: string;
    providerPaymentId: string;
    eventType: "payment.succeeded" | "payment.failed";
    occurredAt: Date;
    payload: unknown;
  }): Promise<{ duplicate: boolean; operation: CashInOperation }> {
    return this.transaction(async (client) => {
      const event = await client.query(
        `INSERT INTO payment_webhook_events
          (provider_event_id, operation_id, provider_payment_id, event_type, occurred_at, payload)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (provider_event_id) DO NOTHING RETURNING provider_event_id`,
        [
          input.providerEventId,
          input.operationId,
          input.providerPaymentId,
          input.eventType,
          input.occurredAt,
          JSON.stringify(input.payload),
        ],
      );
      if (event.rowCount === 0)
        return {
          duplicate: true,
          operation: await this.lockOperation(client, input.operationId),
        };
      const operation =
        input.eventType === "payment.succeeded"
          ? await this.completeInTransaction(
              client,
              input.operationId,
              input.providerPaymentId,
            )
          : await this.failInTransaction(
              client,
              input.operationId,
              "PROVIDER_DECLINED",
              "Payment provider reported a failed payment",
            );
      return { duplicate: false, operation };
    });
  }

  async findRecoverable(limit: number): Promise<CashInOperation[]> {
    const result = await this.pool.query<CashInOperation>(
      `SELECT * FROM cash_in_operations
       WHERE status = 'UNKNOWN'
          OR (status = 'PROCESSING' AND processing_lease_until < NOW())
       ORDER BY updated_at ASC LIMIT $1`,
      [limit],
    );
    return result.rows;
  }

  private async completeInTransaction(
    client: PoolClient,
    operationId: string,
    providerPaymentId: string,
  ): Promise<CashInOperation> {
    const operation = await this.lockOperation(client, operationId);
    if (operation.status === "COMPLETED" || operation.status === "FAILED")
      return operation;

    await client.query(
      "INSERT INTO wallets(user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING",
      [operation.user_id],
    );
    const existingEntry = await client.query<{ balance_after_minor: string }>(
      "SELECT balance_after_minor FROM wallet_ledger_entries WHERE operation_id = $1",
      [operationId],
    );
    let balanceMinor: string;
    if (existingEntry.rowCount === 1) {
      balanceMinor = existingEntry.rows[0].balance_after_minor;
    } else {
      const wallet = await client.query<{ balance_minor: string }>(
        `UPDATE wallets SET balance_minor = balance_minor + $1, updated_at = NOW()
         WHERE user_id = $2 RETURNING balance_minor`,
        [operation.amount_minor, operation.user_id],
      );
      balanceMinor = wallet.rows[0].balance_minor;
      await client.query(
        `INSERT INTO wallet_ledger_entries
          (id, operation_id, user_id, entry_type, amount_minor, balance_after_minor)
         VALUES ($1, $2, $3, 'CASH_IN', $4, $5)`,
        [
          randomUUID(),
          operationId,
          operation.user_id,
          operation.amount_minor,
          balanceMinor,
        ],
      );
    }
    const updated = await client.query<CashInOperation>(
      `UPDATE cash_in_operations
       SET status = 'COMPLETED', provider_payment_id = COALESCE(provider_payment_id, $2),
           new_balance_minor = $3, processing_lease_until = NULL, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [operationId, providerPaymentId, balanceMinor],
    );
    await client.query(
      `INSERT INTO outbox_events(id, aggregate_id, event_type, payload)
       VALUES ($1, $2, 'cash_in.completed', $3::jsonb)
       ON CONFLICT (aggregate_id, event_type) DO NOTHING`,
      [
        randomUUID(),
        operationId,
        JSON.stringify({
          operation_id: operationId,
          user_id: operation.user_id,
          amount_minor: operation.amount_minor,
        }),
      ],
    );
    return updated.rows[0];
  }

  private async failInTransaction(
    client: PoolClient,
    operationId: string,
    code: string,
    reason: string,
  ): Promise<CashInOperation> {
    const operation = await this.lockOperation(client, operationId);
    if (operation.status === "COMPLETED" || operation.status === "FAILED")
      return operation;
    const updated = await client.query<CashInOperation>(
      `UPDATE cash_in_operations
       SET status = 'FAILED', failure_code = $2, failure_reason = $3,
           processing_lease_until = NULL, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [operationId, code, reason],
    );
    return updated.rows[0];
  }

  private async mustGet(operationId: string): Promise<CashInOperation> {
    const operation = await this.getById(operationId);
    if (!operation) throw new Error(`Operation ${operationId} not found`);
    return operation;
  }

  private async lockOperation(
    client: PoolClient,
    operationId: string,
  ): Promise<CashInOperation> {
    const result = await client.query<CashInOperation>(
      "SELECT * FROM cash_in_operations WHERE id = $1 FOR UPDATE",
      [operationId],
    );
    if (result.rowCount !== 1)
      throw new Error(`Operation ${operationId} not found`);
    return result.rows[0];
  }

  private async transaction<T>(
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
