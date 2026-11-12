import { ForbiddenException, Injectable } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";
import { CashInRepository } from "../database/cash-in.repository";
import { PaymentWebhookDto } from "./payment-webhook.dto";

@Injectable()
export class WebhooksService {
  private readonly secret =
    process.env.WEBHOOK_SECRET ?? "local-development-webhook-secret-change-me";

  constructor(private readonly repository: CashInRepository) {}

  async receive(
    signature: string | undefined,
    rawBody: Buffer | undefined,
    payload: PaymentWebhookDto,
  ): Promise<{
    received: true;
    duplicate: boolean;
    operation_id: string;
    status: string;
  }> {
    if (!signature || !rawBody || !this.isValidSignature(signature, rawBody)) {
      throw new ForbiddenException("Invalid webhook signature");
    }
    const result = await this.repository.receiveWebhook({
      providerEventId: payload.provider_event_id,
      operationId: payload.operation_id,
      providerPaymentId: payload.payment_id,
      eventType: payload.type,
      occurredAt: payload.occurred_at,
      payload,
    });
    return {
      received: true,
      duplicate: result.duplicate,
      operation_id: result.operation.id,
      status: result.operation.status.toLowerCase(),
    };
  }

  private isValidSignature(received: string, rawBody: Buffer): boolean {
    const expected = `sha256=${createHmac("sha256", this.secret).update(rawBody).digest("hex")}`;
    const receivedBytes = Buffer.from(received);
    const expectedBytes = Buffer.from(expected);
    return (
      receivedBytes.length === expectedBytes.length &&
      timingSafeEqual(receivedBytes, expectedBytes)
    );
  }
}
