import "dotenv/config";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { json } from "express";
import { Request } from "express";
import { AppModule } from "./app.module";
import { HttpExceptionFilter } from "./common/http-exception.filter";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    bodyParser: false,
  });
  app.use(
    json({
      verify: (request, _response, buffer) => {
        (request as Request).rawBody = buffer;
      },
    }),
  );
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());

  const swaggerConfig = new DocumentBuilder()
    .setTitle("Ligo Wallet Cash-In API")
    .setDescription(
      "Servicio de recarga de wallet con idempotencia multi-pod, conciliación ante timeout y webhooks firmados.",
    )
    .setVersion("1.0.0")
    .addTag("System", "Estado operativo del servicio")
    .addTag("Cash-In", "Operaciones de recarga de wallet")
    .addTag("Webhooks", "Notificaciones verificadas del proveedor de pagos")
    .addApiKey(
      {
        type: "apiKey",
        name: "Idempotency-Key",
        in: "header",
        description:
          "UUID único por intención de cobro. Reutilice el mismo valor en un retry del mismo request.",
      },
      "Idempotency-Key",
    )
    .build();
  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup("docs", app, swaggerDocument, {
    customSiteTitle: "Ligo Wallet Cash-In | API Docs",
    swaggerOptions: { persistAuthorization: true },
  });

  await app.listen(Number(process.env.PORT ?? 3000), "0.0.0.0");
}

void bootstrap();
