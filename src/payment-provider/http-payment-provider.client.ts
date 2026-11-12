import { Injectable } from "@nestjs/common";
import {
  ChargeRequest,
  PaymentProvider,
  ProviderChargeResult,
  ProviderLookupResult,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from "./payment-provider.types";

interface ProviderResponse {
  id: string;
  status: "succeeded" | "failed";
  code?: string;
  reason?: string;
}

@Injectable()
export class HttpPaymentProviderClient implements PaymentProvider {
  private readonly baseUrl = (
    process.env.PAYMENT_PROVIDER_URL ?? "http://localhost:4000"
  ).replace(/\/$/, "");
  private readonly timeoutMs = Number(
    process.env.PAYMENT_PROVIDER_TIMEOUT_MS ?? 2000,
  );

  async charge(input: ChargeRequest): Promise<ProviderChargeResult> {
    const response = await this.fetchJson(`${this.baseUrl}/payments`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": input.operationId,
      },
      body: JSON.stringify({
        operation_id: input.operationId,
        amount_minor: input.amountMinor,
        currency: input.currency,
        payment_method: input.paymentMethod,
      }),
    });
    return this.toChargeResult(response);
  }

  async lookup(operationId: string): Promise<ProviderLookupResult> {
    const controller = AbortSignal.timeout(this.timeoutMs);
    try {
      const response = await fetch(
        `${this.baseUrl}/payments/by-idempotency/${operationId}`,
        { signal: controller },
      );
      if (response.status === 404) return { status: "not_found" };
      if (!response.ok)
        throw new ProviderUnavailableError(
          `Provider lookup failed with HTTP ${response.status}`,
        );
      return this.toChargeResult((await response.json()) as ProviderResponse);
    } catch (error) {
      if (error instanceof ProviderUnavailableError) throw error;
      if (error instanceof Error && error.name === "TimeoutError")
        throw new ProviderTimeoutError();
      throw new ProviderUnavailableError(
        error instanceof Error ? error.message : undefined,
      );
    }
  }

  private async fetchJson(
    url: string,
    init: RequestInit,
  ): Promise<ProviderResponse> {
    const controller = AbortSignal.timeout(this.timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller });
      if (!response.ok)
        throw new ProviderUnavailableError(
          `Provider charge failed with HTTP ${response.status}`,
        );
      return (await response.json()) as ProviderResponse;
    } catch (error) {
      if (error instanceof ProviderUnavailableError) throw error;
      if (error instanceof Error && error.name === "TimeoutError")
        throw new ProviderTimeoutError();
      throw new ProviderUnavailableError(
        error instanceof Error ? error.message : undefined,
      );
    }
  }

  private toChargeResult(response: ProviderResponse): ProviderChargeResult {
    if (response.status === "succeeded")
      return { status: "succeeded", paymentId: response.id };
    return {
      status: "failed",
      code: response.code ?? "PROVIDER_DECLINED",
      reason: response.reason ?? "Payment was declined",
    };
  }
}
