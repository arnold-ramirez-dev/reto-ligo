import {
  CashInOperation,
  CashInRepository,
} from "../database/cash-in.repository";
import { createHash } from "node:crypto";
import {
  PaymentProvider,
  ProviderTimeoutError,
} from "../payment-provider/payment-provider.types";
import { CashInService } from "./cash-in.service";

const operation = (
  overrides: Partial<CashInOperation> = {},
): CashInOperation => ({
  id: "e28925d0-9434-4f49-b1c3-35ea7264d1d1",
  idempotency_key: "b7de6e70-c8ab-4d23-9f50-cf421f59c65b",
  request_hash: "a".repeat(64),
  user_id: "usr_abc123",
  amount_minor: "10000",
  currency: "PEN",
  payment_method: "card_success",
  status: "PENDING",
  provider_payment_id: null,
  failure_code: null,
  failure_reason: null,
  new_balance_minor: null,
  provider_attempts: 0,
  processing_lease_until: null,
  created_at: new Date(),
  updated_at: new Date(),
  ...overrides,
});

const matchingRequestHash = (): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        userId: "usr_abc123",
        amountMinor: 10000,
        currency: "PEN",
        paymentMethod: "card_success",
      }),
    )
    .digest("hex");

describe("CashInService", () => {
  const dto = {
    user_id: "usr_abc123",
    amount: 100,
    currency: "PEN",
    payment_method: "card_success",
  };
  const key = "b7de6e70-c8ab-4d23-9f50-cf421f59c65b";
  let repository: jest.Mocked<
    Pick<
      CashInRepository,
      "createOrGet" | "claimForProcessing" | "complete" | "fail" | "markUnknown"
    >
  >;
  let provider: jest.Mocked<PaymentProvider>;
  let service: CashInService;

  beforeEach(() => {
    repository = {
      createOrGet: jest.fn(),
      claimForProcessing: jest.fn(),
      complete: jest.fn(),
      fail: jest.fn(),
      markUnknown: jest.fn(),
    };
    provider = { charge: jest.fn(), lookup: jest.fn() };
    service = new CashInService(
      repository as unknown as CashInRepository,
      provider,
    );
  });

  it("uses the operation UUID as the provider idempotency key and credits exactly once on success", async () => {
    const pending = operation();
    const completed = operation({
      status: "COMPLETED",
      provider_payment_id: "pay_1",
      new_balance_minor: "35000",
    });
    repository.createOrGet.mockResolvedValue({
      created: true,
      operation: pending,
    });
    repository.claimForProcessing.mockResolvedValue({
      claimed: true,
      operation: pending,
    });
    provider.charge.mockResolvedValue({
      status: "succeeded",
      paymentId: "pay_1",
    });
    repository.complete.mockResolvedValue(completed);

    await expect(service.cashIn(dto, key)).resolves.toEqual({
      httpStatus: 200,
      body: {
        operation_id: pending.id,
        status: "completed",
        amount: 100,
        new_balance: 350,
      },
    });
    expect(provider.charge).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: pending.id, amountMinor: 10000 }),
    );
    expect(repository.complete).toHaveBeenCalledTimes(1);
  });

  it("replays a completed operation without a second provider charge", async () => {
    const completed = operation({
      status: "COMPLETED",
      new_balance_minor: "35000",
      provider_payment_id: "pay_1",
      request_hash: matchingRequestHash(),
    });
    repository.createOrGet.mockResolvedValue({
      created: false,
      operation: completed,
    });

    await expect(service.cashIn(dto, key)).resolves.toMatchObject({
      httpStatus: 200,
      body: { operation_id: completed.id, new_balance: 350 },
    });
    expect(provider.charge).not.toHaveBeenCalled();
    expect(repository.claimForProcessing).not.toHaveBeenCalled();
  });

  it("does not guess after a provider timeout; it persists UNKNOWN for reconciliation", async () => {
    const pending = operation();
    const unknown = operation({ status: "UNKNOWN" });
    repository.createOrGet.mockResolvedValue({
      created: true,
      operation: pending,
    });
    repository.claimForProcessing.mockResolvedValue({
      claimed: true,
      operation: pending,
    });
    provider.charge.mockRejectedValue(new ProviderTimeoutError());
    repository.markUnknown.mockResolvedValue(unknown);

    await expect(service.cashIn(dto, key)).resolves.toMatchObject({
      httpStatus: 202,
      body: { status: "unknown" },
    });
    expect(repository.fail).not.toHaveBeenCalled();
  });

  it("records a provider decline as a terminal failed operation", async () => {
    const pending = operation();
    const failed = operation({
      status: "FAILED",
      failure_code: "PROVIDER_DECLINED",
      failure_reason: "Declined",
    });
    repository.createOrGet.mockResolvedValue({
      created: true,
      operation: pending,
    });
    repository.claimForProcessing.mockResolvedValue({
      claimed: true,
      operation: pending,
    });
    provider.charge.mockResolvedValue({
      status: "failed",
      code: "PROVIDER_DECLINED",
      reason: "Declined",
    });
    repository.fail.mockResolvedValue(failed);

    await expect(service.cashIn(dto, key)).resolves.toMatchObject({
      httpStatus: 422,
      body: { status: "failed", failure: { code: "PROVIDER_DECLINED" } },
    });
  });
});
