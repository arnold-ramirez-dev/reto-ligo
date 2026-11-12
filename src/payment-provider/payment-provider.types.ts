export interface ChargeRequest {
  operationId: string;
  amountMinor: number;
  currency: string;
  paymentMethod: string;
}

export type ProviderChargeResult =
  | { status: "succeeded"; paymentId: string }
  | { status: "failed"; code: string; reason: string };

export type ProviderLookupResult =
  ProviderChargeResult | { status: "not_found" };

export interface PaymentProvider {
  charge(input: ChargeRequest): Promise<ProviderChargeResult>;
  lookup(operationId: string): Promise<ProviderLookupResult>;
}

export const PAYMENT_PROVIDER = Symbol("PAYMENT_PROVIDER");

export class ProviderTimeoutError extends Error {
  constructor() {
    super("Payment provider request timed out; payment outcome is unknown");
    this.name = "ProviderTimeoutError";
  }
}

export class ProviderUnavailableError extends Error {
  constructor(message = "Payment provider is unavailable") {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}
