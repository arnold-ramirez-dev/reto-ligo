import { Module } from "@nestjs/common";
import { PaymentProviderModule } from "../payment-provider/payment-provider.module";
import { CashInController } from "./cash-in.controller";
import { ReconciliationService } from "./reconciliation.service";
import { CashInService } from "./cash-in.service";

@Module({
  imports: [PaymentProviderModule],
  controllers: [CashInController],
  providers: [CashInService, ReconciliationService],
  exports: [CashInService],
})
export class CashInModule {}
