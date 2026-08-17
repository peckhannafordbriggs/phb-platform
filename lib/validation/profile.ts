import { z } from "zod";

/**
 * Profile edit bodies, for both the self-service and the admin routes.
 *
 * Every schema here is a STRICT object. An unknown key is rejected rather than
 * stripped, which is the difference the self-service endpoint depends on: an
 * employee who posts `departmentId` or `isPlatformAdmin` gets a 422 telling them
 * the field is not theirs to set, instead of a 200 that quietly ignored half the
 * request. Fields nobody may change through these routes - email, name, status,
 * the admin flag - are not declared at all, so they cannot reach an update even
 * if a future refactor loosened the strictness.
 */

/** Free text is capped at the same length onboarding uses. */
const positionOtherField = z.string().trim().max(200).nullish();

export const POSITION_REQUIRED = "Position is required.";
export const POSITION_NOT_BOTH =
  "Choose a position from the list or describe it, not both.";

function filled(value: string | null | undefined): boolean {
  return value != null && value.length > 0;
}

/** Shared with onboarding, so the "Other" rule cannot drift between the two. */
export interface PositionChoice {
  positionId?: string | null;
  positionOther?: string | null;
}

export function hasPositionChoice(value: PositionChoice): boolean {
  return filled(value.positionId) || filled(value.positionOther);
}

export function hasOnlyOnePositionChoice(value: PositionChoice): boolean {
  return !(filled(value.positionId) && filled(value.positionOther));
}

/**
 * Position: a row from the positions table, or free text via "Other". Exactly
 * one, the same rule as onboarding.
 *
 * Used by BOTH the self-service route and the admin route. The two differ only
 * in who they let act on whom - never in what a valid position looks like.
 */
export const positionBodySchema = z
  .strictObject({
    positionId: z.uuid().nullish(),
    positionOther: positionOtherField,
  })
  .refine(hasPositionChoice, { message: POSITION_REQUIRED, path: ["positionId"] })
  .refine(hasOnlyOnePositionChoice, {
    message: POSITION_NOT_BOTH,
    path: ["positionOther"],
  });

export type PositionInput = z.infer<typeof positionBodySchema>;

/**
 * Department: admin-only, and always a row from the departments table.
 *
 * There is no free-text equivalent of "Other" here on purpose. Department drives
 * the admin employee filter, so an invented value would fragment it - and unlike
 * position, department is not self-reported.
 */
export const departmentBodySchema = z.strictObject({
  departmentId: z.uuid("Select a department from the list."),
});

export type DepartmentInput = z.infer<typeof departmentBodySchema>;

/**
 * Turns a parse failure into something worth showing a person.
 *
 * Zod's own text for a rejected key is "Unrecognized key: ...", which reads like
 * a bug rather than a boundary. Naming what the caller may actually change is
 * more useful, and it is the same answer whichever field they tried.
 */
export function profileIssueMessage(
  error: z.ZodError,
  allowed: string,
): string {
  const first = error.issues[0];
  if (first === undefined) return "The submitted values are not valid.";
  if (first.code === "unrecognized_keys") {
    return `Only ${allowed} can be changed here.`;
  }
  return first.message;
}
