import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { CashInRepository } from "../database/cash-in.repository";
import { CashInService } from "./cash-in.service";

@Injectable()
export class ReconciliationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReconciliationService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly repository: CashInRepository,
    private readonly cashInService: CashInService,
  ) {}

  onModuleInit(): void {
    const interval = Number(process.env.RECONCILIATION_INTERVAL_MS ?? 10_000);
    this.timer = setInterval(() => {
      void this.reconcile();
    }, interval).unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async reconcile(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const operations = await this.repository.findRecoverable(50);
      for (const operation of operations)
        await this.cashInService.recover(operation);
      if (operations.length)
        this.logger.log(
          JSON.stringify({
            event: "cash_in_reconciled",
            operations: operations.length,
          }),
        );
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: "cash_in_reconciliation_failed",
          error: error instanceof Error ? error.message : "unknown",
        }),
      );
    } finally {
      this.running = false;
    }
  }
}
