import { randomUUID } from "node:crypto";
import request from "supertest";

const baseUrl = process.env.CASH_IN_BASE_URL ?? "http://localhost:3000";

describe("cash-in flow (Docker stack required)", () => {
  it("returns one operation for concurrent app retries and makes the final replay stable", async () => {
    const key = randomUUID();
    const payload = {
      user_id: `usr_e2e_${randomUUID()}`,
      amount: 100,
      currency: "PEN",
      payment_method: "card_success",
    };
    const requests = Array.from({ length: 5 }, () =>
      request(baseUrl)
        .post("/cash-in")
        .set("Idempotency-Key", key)
        .send(payload),
    );
    const responses = await Promise.all(requests);
    expect(
      responses.every((response) => [200, 202].includes(response.status)),
    ).toBe(true);
    expect(
      new Set(responses.map((response) => response.body.operation_id)).size,
    ).toBe(1);

    const replay = await request(baseUrl)
      .post("/cash-in")
      .set("Idempotency-Key", key)
      .send(payload);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({
      status: "completed",
      amount: 100,
      new_balance: 100,
    });
  });

  it("persists a terminal provider failure and replays it instead of retrying a charge", async () => {
    const key = randomUUID();
    const payload = {
      user_id: `usr_e2e_${randomUUID()}`,
      amount: 100,
      currency: "PEN",
      payment_method: "card_declined",
    };
    const first = await request(baseUrl)
      .post("/cash-in")
      .set("Idempotency-Key", key)
      .send(payload);
    const replay = await request(baseUrl)
      .post("/cash-in")
      .set("Idempotency-Key", key)
      .send(payload);
    expect(first.status).toBe(422);
    expect(replay.status).toBe(422);
    expect(replay.body.operation_id).toBe(first.body.operation_id);
  });
});
