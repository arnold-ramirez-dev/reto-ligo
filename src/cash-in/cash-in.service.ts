import { ConflictException, Inject, Injectable, Logger } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { fromMinor, toMinor } from "../common/money";
import {
  CashInOperation,
  CashInRepository,
} from "../database/cash-in.repository";
import {
  PAYMENT_PROVIDER,
  PaymentProvider,
  ProviderTimeoutError,
} from "../payment-provider/payment-provider.types";
import { CashInRequestDto, isSupportedCurrency } from "./cash-in.dto";

export interface CashInResponse {
  httpStatus: 200 | 202 | 422;
  body: {
    operation_id: string;
    status: "completed" | "processing" | "unknown" | "failed";
    amount: number;
    new_balance?: number;
    failure?: { code: string; message: string };
  };
}

@Injectable()
export class CashInService {
  private readonly logger = new Logger(CashInService.name);

  constructor(
    private readonly repository: CashInRepository,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  async cashIn(
    dto: CashInRequestDto,
    idempotencyKey: string,
  ): Promise<CashInResponse> {
    const amountMinor = toMinor(dto.amount);
    const currency = dto.currency.toUpperCase();
    if (!isSupportedCurrency(currency))
      throw new ConflictException("Unsupported currency");
    const requestHash = this.fingerprint(
      dto.user_id,
      amountMinor,
      currency,
      dto.payment_method,
    );
    const created = await this.repository.createOrGet({
      id: randomUUID(),
      idempotencyKey,
      requestHash,
      userId: dto.user_id,
      amountMinor,
      currency,
      paymentMethod: dto.payment_method,
    });
    if (!created.created && created.operation.request_hash !== requestHash) {
      throw new ConflictException(
        "Idempotency-Key was already used with a different request payload",
      );
    }
    if (
      created.operation.status === "COMPLETED" ||
      created.operation.status === "FAILED"
    )
      return this.toResponse(created.operation);

    const claim = await this.repository.claimForProcessing(
      created.operation.id,
    );
    if (!claim.claimed) return this.toResponse(claim.operation);
    return this.executeProviderCall(claim.operation);
  }

  async recover(operation: CashInOperation): Promise<void> {
    try {
      const knownOutcome = await this.provider.lookup(operation.id);
      if (knownOutcome.status === "succeeded") {
        await this.repository.complete(operation.id, knownOutcome.paymentId);
        return;
      }
      if (knownOutcome.status === "failed") {
        await this.repository.fail(
          operation.id,
          knownOutcome.code,
          knownOutcome.reason,
        );
        return;
      }
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: "provider_lookup_unavailable",
          operationId: operation.id,
          error: error instanceof Error ? error.message : "unknown",
        }),
      );
      return;
    }
    const claim = await this.repository.claimForProcessing(operation.id);
    if (claim.claimed) await this.executeProviderCall(claim.operation);
  }

  private async executeProviderCall(
    operation: CashInOperation,
  ): Promise<CashInResponse> {
    try {
      const result = await this.provider.charge({
        operationId: operation.id,
        amountMinor: Number(operation.amount_minor),
        currency: operation.currency,
        paymentMethod: operation.payment_method,
      });
      const finalOperation =
        result.status === "succeeded"
          ? await this.repository.complete(operation.id, result.paymentId)
          : await this.repository.fail(
              operation.id,
              result.code,
              result.reason,
            );
      return this.toResponse(finalOperation);
    } catch (error) {
      if (error instanceof ProviderTimeoutError) {
        const unknown = await this.repository.markUnknown(operation.id);
        this.logger.warn(
          JSON.stringify({
            event: "provider_timeout_unknown_outcome",
            operationId: operation.id,
          }),
        );
        return this.toResponse(unknown);
      }
      const unknown = await this.repository.markUnknown(operation.id);
      this.logger.error(
        JSON.stringify({
          event: "provider_transport_outcome_unknown",
          operationId: operation.id,
          error: error instanceof Error ? error.message : "unknown",
        }),
      );
      return this.toResponse(unknown);
    }
  }

  private toResponse(operation: CashInOperation): CashInResponse {
    const base = {
      operation_id: operation.id,
      amount: fromMinor(operation.amount_minor),
    };
    if (operation.status === "COMPLETED")
      return {
        httpStatus: 200,
        body: {
          ...base,
          status: "completed",
          new_balance: fromMinor(operation.new_balance_minor ?? 0),
        },
      };
    if (operation.status === "FAILED")
      return {
        httpStatus: 422,
        body: {
          ...base,
          status: "failed",
          failure: {
            code: operation.failure_code ?? "PAYMENT_FAILED",
            message: operation.failure_reason ?? "Payment failed",
          },
        },
      };
    return {
      httpStatus: 202,
      body: {
        ...base,
        status: operation.status === "UNKNOWN" ? "unknown" : "processing",
      },
    };
  }

  private fingerprint(
    userId: string,
    amountMinor: number,
    currency: string,
    paymentMethod: string,
  ): string {
    return createHash("sha256")
      .update(JSON.stringify({ userId, amountMinor, currency, paymentMethod }))
      .digest("hex");
  }
}
