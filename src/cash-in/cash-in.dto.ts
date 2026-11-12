import { Type } from "class-transformer";
import { IsNumber, IsString, Length, Matches, Max, Min } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class CashInRequestDto {
  @ApiProperty({
    example: "usr_abc123",
    description: "Identificador del titular de la wallet",
  })
  @IsString()
  @Length(1, 128)
  user_id!: string;

  @ApiProperty({
    example: 100.0,
    minimum: 0.01,
    maximum: 10_000_000,
    description: "Monto a acreditar, con máximo dos decimales",
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0.01)
  @Max(10_000_000)
  amount!: number;

  @ApiProperty({
    example: "PEN",
    description: "Código ISO 4217. El alcance actual admite PEN",
  })
  @IsString()
  @Matches(/^[A-Za-z]{3}$/)
  currency!: string;

  @ApiProperty({
    example: "card_success",
    description:
      "Token o método de pago previamente tokenizado; nunca se envían datos de tarjeta",
  })
  @IsString()
  @Length(1, 128)
  payment_method!: string;
}

export class CashInCompletedResponseDto {
  @ApiProperty({
    format: "uuid",
    example: "a631e10a-19bd-4f54-9fb8-39b2eac5e4a1",
  })
  operation_id!: string;

  @ApiProperty({ enum: ["completed"], example: "completed" })
  status!: "completed";

  @ApiProperty({ example: 100.0 })
  amount!: number;

  @ApiProperty({ example: 350.0 })
  new_balance!: number;
}

export class CashInPendingResponseDto {
  @ApiProperty({
    format: "uuid",
    example: "a631e10a-19bd-4f54-9fb8-39b2eac5e4a1",
  })
  operation_id!: string;

  @ApiProperty({
    enum: ["processing", "unknown"],
    example: "unknown",
    description:
      "unknown significa que el proveedor no respondió de forma concluyente; se concilia de forma segura",
  })
  status!: "processing" | "unknown";

  @ApiProperty({ example: 100.0 })
  amount!: number;
}

export class CashInFailedResponseDto {
  @ApiProperty({
    format: "uuid",
    example: "a631e10a-19bd-4f54-9fb8-39b2eac5e4a1",
  })
  operation_id!: string;

  @ApiProperty({ enum: ["failed"], example: "failed" })
  status!: "failed";

  @ApiProperty({ example: 100.0 })
  amount!: number;

  @ApiProperty({
    example: { code: "PROVIDER_DECLINED", message: "Payment was declined" },
  })
  failure!: { code: string; message: string };
}

export class CashInHeadersDto {
  @IsString()
  @Matches(
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/,
  )
  idempotencyKey!: string;
}

export const SUPPORTED_CURRENCY = ["PEN"] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCY)[number];

export const isSupportedCurrency = (
  currency: string,
): currency is SupportedCurrency =>
  SUPPORTED_CURRENCY.includes(currency as SupportedCurrency);
