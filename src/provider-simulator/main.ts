import "dotenv/config";
import { createHmac, randomUUID } from "node:crypto";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { Pool } from "pg";

interface PaymentRequest {
  operation_id: string;
  amount_minor: number;
  currency: string;
  payment_method: string;
}
interface ProviderPayment {
  id: string;
  idempotency_key: string;
  status: "succeeded" | "failed";
  payment_method: string;
}

const port = Number(process.env.PAYMENT_PROVIDER_PORT ?? 4000);
const database = new Pool({
  connectionString: process.env.DATABASE_URL,
  application_name: "payment-provider-simulator",
});
const webhookUrl =
  process.env.WEBHOOK_URL ?? "http://localhost:3000/webhooks/payment";
const webhookSecret =
  process.env.WEBHOOK_SECRET ?? "local-development-webhook-secret-change-me";

const response = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const readBody = async (req: IncomingMessage): Promise<PaymentRequest> =>
  new Promise((resolve, reject) => {
    const buffers: Buffer[] = [];
    req.on("data", (chunk: Buffer) => buffers.push(chunk));
    req.on("end", () => {
      try {
        resolve(
          JSON.parse(Buffer.concat(buffers).toString("utf8")) as PaymentRequest,
        );
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });

const sendWebhook = async (
  payment: ProviderPayment,
  operationId: string,
  duplicate = false,
): Promise<void> => {
  const payload = JSON.stringify({
    provider_event_id: `evt_${payment.id}${duplicate ? "_duplicate" : ""}`,
    operation_id: operationId,
    payment_id: payment.id,
    type:
      payment.status === "succeeded" ? "payment.succeeded" : "payment.failed",
    occurred_at: new Date().toISOString(),
  });
  const signature = `sha256=${createHmac("sha256", webhookSecret).update(payload).digest("hex")}`;
  await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-provider-signature": signature,
    },
    body: payload,
  });
};

const getPayment = async (
  key: string,
): Promise<ProviderPayment | undefined> => {
  const result = await database.query<ProviderPayment>(
    "SELECT id, idempotency_key, status, payment_method FROM provider_simulator_payments WHERE idempotency_key = $1",
    [key],
  );
  return result.rows[0];
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (
      req.method === "GET" &&
      url.pathname.startsWith("/payments/by-idempotency/")
    ) {
      const payment = await getPayment(url.pathname.split("/").pop() ?? "");
      return payment
        ? response(res, 200, payment)
        : response(res, 404, { message: "not found" });
    }
    if (req.method === "POST" && url.pathname === "/payments") {
      const idempotencyKey = req.headers["idempotency-key"];
      if (typeof idempotencyKey !== "string")
        return response(res, 400, { message: "Idempotency-Key required" });
      const body = await readBody(req);
      let payment = await getPayment(idempotencyKey);
      if (!payment) {
        const status =
          body.payment_method === "card_declined" ||
          body.payment_method === "card_webhook_failed"
            ? "failed"
            : "succeeded";
        const id = `pay_${randomUUID().replaceAll("-", "")}`;
        const inserted = await database.query<ProviderPayment>(
          `INSERT INTO provider_simulator_payments(id, idempotency_key, operation_id, amount_minor, currency, payment_method, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING id, idempotency_key, status, payment_method`,
          [
            id,
            idempotencyKey,
            body.operation_id,
            body.amount_minor,
            body.currency,
            body.payment_method,
            status,
          ],
        );
        payment = inserted.rows[0] ?? (await getPayment(idempotencyKey));
      }
      if (!payment) throw new Error("Failed to create provider payment");
      if (
        body.payment_method === "card_webhook_first" ||
        body.payment_method === "card_webhook_failed"
      )
        await sendWebhook(payment, body.operation_id);
      if (body.payment_method === "card_webhook_duplicate") {
        await sendWebhook(payment, body.operation_id);
        await sendWebhook(payment, body.operation_id);
      }
      if (body.payment_method === "card_timeout_after_charge")
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      return response(
        res,
        200,
        payment.status === "succeeded"
          ? { id: payment.id, status: "succeeded" }
          : {
              id: payment.id,
              status: "failed",
              code: "PROVIDER_DECLINED",
              reason: "Simulated card decline",
            },
      );
    }
    return response(res, 404, { message: "not found" });
  } catch (error) {
    console.error(error);
    return response(res, 500, { message: "provider simulator error" });
  }
});

server.listen(port, "0.0.0.0", () =>
  console.log(`Payment provider simulator listening on ${port}`),
);
