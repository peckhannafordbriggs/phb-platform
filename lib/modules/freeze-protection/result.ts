import { Prisma } from "@/lib/generated/prisma/client";

/**
 * Every Freeze Protection write returns a result instead of throwing, the shape
 * CIP and lib/admin/service.ts use. The routes turn a code into a status with
 * FP_ERROR_STATUS and nothing else.
 */

export type FpErrorCode =
  | "not_found"
  | "invalid"
  | "job_number_taken"
  | "building_name_taken"
  | "tag_taken"
  | "building_not_empty"
  | "last_building"
  | "already_signed"
  | "not_completed"
  | "self_review";

export type FpResult<T> = { ok: true; data: T } | { ok: false; code: FpErrorCode; message: string };

export const FP_ERROR_STATUS: Record<FpErrorCode, number> = {
  not_found: 404,
  invalid: 422,
  job_number_taken: 409,
  building_name_taken: 409,
  tag_taken: 409,
  building_not_empty: 409,
  last_building: 409,
  already_signed: 409,
  not_completed: 409,
  self_review: 409,
};

export const ok = <T>(data: T): FpResult<T> => ({ ok: true, data });
export const fail = <T>(code: FpErrorCode, message: string): FpResult<T> => ({ ok: false, code, message });

/** A route param to an id, or null for anything that is not a positive whole number. */
export function parseId(raw: string): bigint | null {
  return /^[1-9]\d{0,18}$/.test(raw) ? BigInt(raw) : null;
}

export const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

/** Trimmed, with empty meaning "not answered". Text fields are free text from the drawings or the field. */
export function cleanText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export const NAME_MAX = 200;
export const TEXT_MAX = 2000;
