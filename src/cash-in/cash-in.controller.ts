import { Body, Controller, Headers, HttpCode, Post, Res } from "@nestjs/common";
import { Response } from "express";
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiSecurity,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from "@nestjs/swagger";
import {
  CashInCompletedResponseDto,
  CashInFailedResponseDto,
  CashInPendingResponseDto,
  CashInRequestDto,
} from "./cash-in.dto";
import { CashInService } from "./cash-in.service";

@Controller()
@ApiTags("Cash-In")
export class CashInController {
  constructor(private readonly cashInService: CashInService) {}

  @Post("cash-in")
  @HttpCode(200)
  @ApiOperation({
    summary: "Crear o recuperar una recarga idempotente",
    description:
      "Con la misma Idempotency-Key y payload se devuelve el mismo resultado. Un timeout del PSP devuelve unknown, no genera un segundo cobro.",
  })
  @ApiSecurity("Idempotency-Key")
  @ApiHeader({
    name: "Idempotency-Key",
    required: true,
    description:
      "UUID único por intención de cobro. Debe mantenerse en reintentos.",
    schema: {
      type: "string",
      format: "uuid",
      example: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    },
  })
  @ApiResponse({
    status: 200,
    description: "Cobro confirmado o replay idempotente de un cobro confirmado",
    type: CashInCompletedResponseDto,
  })
  @ApiResponse({
    status: 202,
    description:
      "Otro pod está procesando o el resultado externo es incierto y será conciliado",
    type: CashInPendingResponseDto,
  })
  @ApiUnprocessableEntityResponse({
    description: "El proveedor confirmó el rechazo",
    type: CashInFailedResponseDto,
  })
  @ApiBadRequestResponse({
    description: "Body inválido o header Idempotency-Key ausente/no UUID",
  })
  @ApiConflictResponse({
    description: "La Idempotency-Key ya fue usada con un payload diferente",
  })
  async cashIn(
    @Body() body: CashInRequestDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (
      !idempotencyKey ||
      !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(
        idempotencyKey,
      )
    ) {
      response.status(400);
      return { message: "Idempotency-Key header must be a UUID" };
    }
    const result = await this.cashInService.cashIn(body, idempotencyKey);
    response.status(result.httpStatus);
    return result.body;
  }
}
