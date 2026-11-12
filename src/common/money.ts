import { BadRequestException } from "@nestjs/common";

export const toMinor = (amount: number): number => {
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) {
    throw new BadRequestException(
      "amount must be a positive amount up to 10,000,000.00",
    );
  }
  const minor = Math.round((amount + Number.EPSILON) * 100);
  if (
    !Number.isSafeInteger(minor) ||
    Math.abs(minor / 100 - amount) > 0.000_000_1
  ) {
    throw new BadRequestException("amount supports at most two decimal places");
  }
  return minor;
};

export const fromMinor = (minor: number | string): number =>
  Number(minor) / 100;
