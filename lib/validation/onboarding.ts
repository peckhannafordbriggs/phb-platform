import { z } from "zod";
import {
  hasOnlyOnePositionChoice,
  hasPositionChoice,
  POSITION_NOT_BOTH,
  POSITION_REQUIRED,
} from "./profile";

/**
 * Profile completion, not account creation - the person is already
 * authenticated.
 *
 * email, status and isPlatformAdmin are not fields here. Zod strips unknown
 * keys, so a request body containing them cannot reach the update: they are
 * structurally impossible to accept rather than filtered out by a rule someone
 * could later forget to apply.
 *
 * The "Other" position rule is imported rather than restated. Onboarding and the
 * two profile-edit routes have to agree about what a valid position is, and three
 * copies of the rule is how they stop agreeing.
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
  .refine(hasPositionChoice, {
    message: POSITION_REQUIRED,
    path: ["positionId"],
  })
  .refine(hasOnlyOnePositionChoice, {
    message: POSITION_NOT_BOTH,
    path: ["positionOther"],
  });

export type OnboardingInput = z.infer<typeof onboardingSchema>;
