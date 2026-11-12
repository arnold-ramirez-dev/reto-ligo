import { Body, Controller, Headers, HttpCode, Post, Req } from "@nestjs/common";
import { Request } from "express";
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import { PaymentWebhookDto } from "./payment-webhook.dto";
import { WebhooksService } from "./webhooks.service";

@Controller("webhooks")
@ApiTags("Webhooks")
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  @Post("payment")
  @HttpCode(200)
  @ApiOperation({
    summary: "Recibir notificación del proveedor de pagos",
    description:
      "Valida HMAC SHA-256 del body crudo y deduplica por provider_event_id. No requiere autenticación de usuario.",
  })
  @ApiHeader({
    name: "X-Provider-Signature",
    required: true,
    description: "HMAC SHA-256 del body crudo: sha256=<hex>",
    schema: {
      type: "string",
      example: "sha256=5d41402abc4b2a76b9719d911017c592",
    },
  })
  @ApiOkResponse({
    description: "Evento procesado o entrega duplicada reconocida",
    schema: {
      example: {
        received: true,
        duplicate: false,
        operation_id: "a631e10a-19bd-4f54-9fb8-39b2eac5e4a1",
        status: "completed",
      },
    },
  })
  @ApiBadRequestResponse({ description: "Payload de webhook inválido" })
  @ApiForbiddenResponse({ description: "Firma ausente o inválida" })
  async payment(
    @Headers("x-provider-signature") signature: string | undefined,
    @Req() request: Request,
    @Body() body: PaymentWebhookDto,
  ) {
    return this.webhooksService.receive(signature, request.rawBody, body);
  }
}
