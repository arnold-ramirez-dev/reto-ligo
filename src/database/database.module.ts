import { Global, Inject, Module, OnModuleDestroy } from "@nestjs/common";
import { Pool } from "pg";
import { CashInRepository } from "./cash-in.repository";
import { PG_POOL } from "./tokens";

export { PG_POOL } from "./tokens";

export class DatabaseLifecycle implements OnModuleDestroy {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: (): Pool =>
        new Pool({
          connectionString: process.env.DATABASE_URL,
          max: Number(process.env.DATABASE_POOL_MAX ?? 15),
          application_name: "wallet-cash-in",
        }),
    },
    DatabaseLifecycle,
    CashInRepository,
  ],
  exports: [PG_POOL, CashInRepository],
})
export class DatabaseModule {}
