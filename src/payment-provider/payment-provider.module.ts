import { Module } from "@nestjs/common";
import { HttpPaymentProviderClient } from "./http-payment-provider.client";
import { PAYMENT_PROVIDER } from "./payment-provider.types";

@Module({
  providers: [
    HttpPaymentProviderClient,
    { provide: PAYMENT_PROVIDER, useExisting: HttpPaymentProviderClient },
  ],
  exports: [PAYMENT_PROVIDER],
})
export class PaymentProviderModule {}
