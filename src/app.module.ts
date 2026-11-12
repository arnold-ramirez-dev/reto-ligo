import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { AppController } from "./app.controller";
import { CashInModule } from "./cash-in/cash-in.module";
import { RequestContextMiddleware } from "./common/request-context.middleware";
import { DatabaseModule } from "./database/database.module";
import { WebhooksModule } from "./webhooks/webhooks.module";

@Module({
  imports: [DatabaseModule, CashInModule, WebhooksModule],
  controllers: [AppController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes("*");
  }
}
