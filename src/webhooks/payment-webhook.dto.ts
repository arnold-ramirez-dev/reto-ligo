import { Type } from "class-transformer";
import { IsDate, IsIn, IsString, IsUUID, Length } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class PaymentWebhookDto {
  @ApiProperty({ example: "evt_pay_01J4KX5Q5F5YXJX0VGP0MZK5V2" })
  @IsString()
  @Length(1, 128)
  provider_event_id!: string;

  @ApiProperty({
    format: "uuid",
    example: "a631e10a-19bd-4f54-9fb8-39b2eac5e4a1",
  })
  @IsUUID()
  operation_id!: string;

  @ApiProperty({ example: "pay_01J4KX5Q5F5YXJX0VGP0MZK5V2" })
  @IsString()
  @Length(1, 128)
  payment_id!: string;

  @ApiProperty({
    enum: ["payment.succeeded", "payment.failed"],
    example: "payment.succeeded",
  })
  @IsIn(["payment.succeeded", "payment.failed"])
  type!: "payment.succeeded" | "payment.failed";

  @ApiProperty({ example: "2026-08-01T10:00:00.000Z", format: "date-time" })
  @Type(() => Date)
  @IsDate()
  occurred_at!: Date;
}
