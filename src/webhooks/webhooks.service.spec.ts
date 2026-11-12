import { createHmac } from "node:crypto";
import { CashInRepository } from "../database/cash-in.repository";
import { WebhooksService } from "./webhooks.service";

describe("WebhooksService", () => {
  const body = {
    provider_event_id: "evt_pay_123",
    operation_id: "e28925d0-9434-4f49-b1c3-35ea7264d1d",
    payment_id: "pay_123",
    type: "payment.succeeded" as const,
    occurred_at: new Date("2026-08-01T10:00:00.000Z"),
  };

  it("accepts a valid signed webhook and reports duplicate delivery without reprocessing it", async () => {
    const receiveWebhook = jest.fn().mockResolvedValue({
      duplicate: true,
      operation: { id: body.operation_id, status: "COMPLETED" },
    });
    const service = new WebhooksService({
      receiveWebhook,
    } as unknown as CashInRepository);
    const rawBody = Buffer.from(JSON.stringify(body));
    const signature = `sha256=${createHmac(
      "sha256",
      process.env.WEBHOOK_SECRET ??
        "local-development-webhook-secret-change-me",
    )
      .update(rawBody)
      .digest("hex")}`;

    await expect(service.receive(signature, rawBody, body)).resolves.toEqual({
      received: true,
      duplicate: true,
      operation_id: body.operation_id,
      status: "completed",
    });
    expect(receiveWebhook).toHaveBeenCalledTimes(1);
  });
});
