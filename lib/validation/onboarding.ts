import { z } from "zod";

/**
 * Profile completion, not account creation - the person is already
 * authenticated.
 *
 * email, status and isPlatformAdmin are not fields here. Zod strips unknown
 * keys, so a request body containing them cannot reach the update: they are
 * structurally impossible to accept rather than filtered out by a rule someone
 * could later forget to apply.
 */
export const onboardingSchema = z
  .object({
    firstName: z.string().trim().min(1, "First name is required.").max(100),
    lastName: z.string().trim().min(1, "Last name is required.").max(100),

    // Exactly one of these two. "Other" reveals the free-text field and flags
    // the row for admin cleanup.
    positionId: z.uuid().nullish(),
    positionOther: z.string().trim().max(200).nullish(),

    departmentId: z.uuid("Department is required."),
  })
  .refine(
    (v) =>
      (v.positionId != null && v.positionId.length > 0) ||
      (v.positionOther != null && v.positionOther.length > 0),
    { message: "Position is required.", path: ["positionId"] },
  )
  .refine(
    (v) =>
      !(
        v.positionId != null &&
        v.positionId.length > 0 &&
        v.positionOther != null &&
        v.positionOther.length > 0
      ),
    {
      message: "Choose a position from the list or describe it, not both.",
      path: ["positionOther"],
    },
  );

export type OnboardingInput = z.infer<typeof onboardingSchema>;
