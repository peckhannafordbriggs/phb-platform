import { z } from "zod";
import { isDateOnly } from "./dates";
import { COIL_VALUES, CONFIRMED_WITH_VALUES, EXPOSURE_SUGGESTION_VALUES, EXPOSURE_VALUES, PROTECTION_VALUES, STATUS_VALUES } from "./vocab";
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
  /** Defaults to today in America/New_York. */
  verificationDate: dateOnly.optional(),
});

/** The project and its one verification: identity, date and transmittal. Signoff has its own route. */
export const updateProjectSchema = z.strictObject({
  jobNumber: name.optional(),
  name: name.optional(),
  verificationDate: dateOnly.optional(),
  transmittedTo: shortText.optional(),
  transmittedDate: dateOnly.nullable().optional(),
});

export const signSchema = z.strictObject({
  role: z.enum(["completed", "reviewed"]),
  /** false removes the signature instead. */
  signed: z.boolean(),
});

/** What the equipment schedule says about a unit. Type and area served are optional. */
const scheduleFields = {
  name: name.optional(),
  equipmentType: shortText.optional(),
  areaServed: shortText.optional(),
  coil: z.enum(COIL_VALUES).nullable().optional(),
  notes: text.optional(),
};

export const createEquipmentSchema = z.strictObject({
  projectId: z.string(),
  ...scheduleFields,
  name,
});

/**
 * One save from the step pane: any subset of the unit's schedule fields and
 * verification answers. Every field optional, because the pane saves one at a time.
 */
export const updateEquipmentSchema = z.strictObject({
  ...scheduleFields,
  sortOrder: z.number().int().min(0).max(1_000_000).optional(),
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
});

/**
 * One schedule cut out of the uploaded PDF, sent back by the browser to be
 * read. The browser holds the cut-out text between the split and the read, so
 * no upload is stored; the size caps keep one call bounded.
 */
export const analyzeScheduleSchema = z.strictObject({
  key: z.string().max(40),
  page: z.number().int().min(1).max(1000),
  sheet: shortText,
  title: name,
  part: shortText,
  text: z.string().min(1).max(200_000),
  marks: z.number().int().min(0).max(10_000),
});

/** The units the reviewer kept, saved in one go. */
export const IMPORT_MAX_ROWS = 1000;
export const importEquipmentSchema = z.strictObject({
  projectId: z.string(),
  fileName: name,
  rows: z
    .array(
      z.strictObject({
        name,
        equipmentType: shortText,
        areaServed: shortText,
        coil: z.enum(COIL_VALUES),
        exposureSuggestion: z.enum(EXPOSURE_SUGGESTION_VALUES).nullable(),
        exposureEvidence: z.string().max(500).nullable(),
        source: shortText,
      }),
    )
    .min(1)
    .max(IMPORT_MAX_ROWS),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
export type CreateEquipmentInput = z.infer<typeof createEquipmentSchema>;
export type UpdateEquipmentInput = z.infer<typeof updateEquipmentSchema>;
export type AnalyzeScheduleInput = z.infer<typeof analyzeScheduleSchema>;
export type ImportEquipmentInput = z.infer<typeof importEquipmentSchema>;
