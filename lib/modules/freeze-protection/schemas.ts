import { z } from "zod";
import { isDateOnly } from "./dates";
import { COIL_VALUES, CONFIRMED_WITH_VALUES, EXPOSURE_VALUES, PROTECTION_VALUES, STATUS_VALUES } from "./vocab";
import { NAME_MAX, TEXT_MAX } from "./result";

/**
 * Request shapes, shared by the routes and the tests. Strict everywhere, so a
 * misspelled field is a 422 instead of a silent no-op (the CIP and BAS rule).
 */

const name = z.string().max(NAME_MAX);
const text = z.string().max(TEXT_MAX).nullable();
const shortText = z.string().max(NAME_MAX).nullable();
const dateOnly = z.string().refine(isDateOnly, "Use YYYY-MM-DD.");
const yesNo = z.enum(["yes", "no"]).nullable();

export const createProjectSchema = z.strictObject({
  jobNumber: name,
  name,
  /** At least one; a single-building job has one. */
  buildings: z.array(name).min(1).max(50),
});

export const updateProjectSchema = z.strictObject({
  jobNumber: name.optional(),
  name: name.optional(),
});

export const buildingSchema = z.strictObject({ name });

export const createEquipmentSchema = z.strictObject({
  buildingId: z.string(),
  tag: name,
  equipmentType: shortText.optional(),
  areaServed: shortText.optional(),
  coil: z.enum(COIL_VALUES).nullable().optional(),
  notes: text.optional(),
});

export const updateEquipmentSchema = z.strictObject({
  buildingId: z.string().optional(),
  tag: name.optional(),
  equipmentType: shortText.optional(),
  areaServed: shortText.optional(),
  coil: z.enum(COIL_VALUES).nullable().optional(),
  notes: text.optional(),
  sortOrder: z.number().int().min(0).max(1_000_000).optional(),
});

export const createVerificationSchema = z.strictObject({ verificationDate: dateOnly });

export const updateVerificationSchema = z.strictObject({
  verificationDate: dateOnly.optional(),
  transmittedTo: shortText.optional(),
  transmittedDate: dateOnly.nullable().optional(),
});

export const signSchema = z.strictObject({
  role: z.enum(["completed", "reviewed"]),
  /** false removes the signature instead. */
  signed: z.boolean(),
});

/** One unit in one round. Every field optional: the step pane saves one field at a time. */
export const updateResultSchema = z.strictObject({
  status: z.enum(STATUS_VALUES).optional(),
  exposure: z.enum(EXPOSURE_VALUES).nullable().optional(),
  protection: z.enum(PROTECTION_VALUES).nullable().optional(),
  testFanStops: yesNo.optional(),
  testDamperCloses: yesNo.optional(),
  testValveFullFlow: yesNo.optional(),
  testManualReset: yesNo.optional(),
  /** Freezestats trip in the 30s °F; the range only refuses typing slips. */
  tripTempF: z.number().min(-40).max(120).nullable().optional(),
  testedBy: shortText.optional(),
  testDate: dateOnly.nullable().optional(),
  elements: shortText.optional(),
  notifyWho: shortText.optional(),
  notifyDate: dateOnly.nullable().optional(),
  notifyMethod: shortText.optional(),
  notifyResponse: text.optional(),
  deficiencyDescription: text.optional(),
  deficiencyOwner: shortText.optional(),
  deficiencyDue: dateOnly.nullable().optional(),
  documentedWith: z.enum(CONFIRMED_WITH_VALUES).nullable().optional(),
  documentedName: shortText.optional(),
  documentedDate: dateOnly.nullable().optional(),
  documentedMethod: shortText.optional(),
  notes: text.optional(),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
export type CreateEquipmentInput = z.infer<typeof createEquipmentSchema>;
export type UpdateEquipmentInput = z.infer<typeof updateEquipmentSchema>;
export type UpdateVerificationInput = z.infer<typeof updateVerificationSchema>;
export type UpdateResultInput = z.infer<typeof updateResultSchema>;
