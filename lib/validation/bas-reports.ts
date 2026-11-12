import { z } from "zod";
import { ANALYSIS_WINDOWS, MAX_INTERVAL_DAYS } from "@/lib/modules/bas/reports/schedule";
import { EMAIL_SHAPE } from "@/lib/modules/bas/reports/recipients";
import { MAX_CEILING_MINUTES, MAX_CEILING_USD } from "@/lib/modules/bas/reports/ceiling";

/**
 * What the Reports screens may send (Phase 1).
 *
 * Shape only, as in bas-settings.ts. Whether a building exists and is the
 * viewer's to see, whether a name is taken, whether a schedule can ever fire
 * and whether an address is the owner's are the service's questions.
 *
 * IDs are strings: the tables key on bigint and a JS number rounds past 2^53.
 */

const bigintText = z
  .string()
  .trim()
  .regex(/^[0-9]+$/, "That is not a valid id.")
  .max(20);

const reportName = z
  .string()
  .trim()
  .min(1, "Enter a name for the report.")
  .max(120, "Names are limited to 120 characters.");

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value.length === 0 ? null : value))
    .nullable()
    .optional();

/** HH:MM, 24-hour. The database CHECK is the same pattern. */
const timeOfDay = z
  .string()
  .trim()
  .regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, "Enter the time as HH:MM, for example 06:00.");

const calendarDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the start date as YYYY-MM-DD.");

/**
 * The schedule, discriminated on kind. The arithmetic (can it fire; are the
 * weekdays distinct) is `scheduleProblem` in the service; this is the shape.
 */
export const scheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("daily") }),
  z.object({
    kind: z.literal("every_n_days"),
    intervalDays: z.number().int().min(2).max(MAX_INTERVAL_DAYS),
    anchorDate: calendarDate,
  }),
  z.object({
    kind: z.literal("weekly"),
    weekdays: z.array(z.number().int().min(1).max(7)).min(1, "Choose at least one weekday.").max(7),
  }),
  z.object({
    kind: z.literal("monthly"),
    dayOfMonth: z.number().int().min(1).max(31),
  }),
]);

const analysisWindow = z.enum(ANALYSIS_WINDOWS);
const presetKey = z.enum(["health_weekly", "health_daily"]);

const questionText = z
  .string()
  .trim()
  .min(1, "Type the question.")
  .max(1000, "Questions are limited to 1,000 characters.");

/**
 * One question in a report's selection (2026-11-12). Three kinds, each
 * naming exactly what it needs. `saveToLibrary` on an inline question also
 * saves the text to the viewer's personal library and stores the question
 * as a personal one, so it is offered under My questions next time.
 */
export const questionSelectionItemSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("library"), libraryQuestionId: bigintText }).strict(),
  z.object({ kind: z.literal("personal"), personalQuestionId: bigintText }).strict(),
  z
    .object({
      kind: z.literal("inline"),
      text: questionText,
      saveToLibrary: z.boolean().optional(),
    })
    .strict(),
]);

/**
 * The whole selection, as the editor's checklist holds it. The service
 * stores it in its canonical order - shared questions in library order,
 * then the viewer's own, then typed ones - whatever order it arrives in.
 */
export const questionSelectionSchema = z.array(questionSelectionItemSchema).max(200);

/**
 * The two per-report caps were removed on 2026-11-12 in favour of the
 * module's safety ceiling. A client still sending them is an old build of
 * the editor; it is answered 400 with this sentence rather than having the
 * keys dropped on the floor, so the mismatch is seen.
 */
export const REMOVED_LIMIT_KEYS = ["budgetUsd", "maxMinutes"] as const;
export const REMOVED_LIMITS_MESSAGE =
  "Per-report limits were removed on 2026-11-12. The module's safety ceiling on the Usage page applies to every run; do not send budgetUsd or maxMinutes.";

export const createReportSchema = z
  .object({
    name: reportName,
    description: optionalText(2000),
    siteId: bigintText,
    stationIds: z.array(bigintText).max(200).optional(),
    /** The preset last clicked in the editor, kept as a label only while the selection matches it. */
    presetKey: presetKey.nullable().optional(),
    analysisWindow: analysisWindow.optional(),
    schedule: scheduleSchema,
    timeOfDay,
    questions: questionSelectionSchema.optional(),
  })
  .strict();

/**
 * Edit carries only what changes. A key ABSENT leaves the field alone; a key
 * present with null clears what can be cleared (description, the preset
 * label). `schedule` and `timeOfDay` travel together or not at all: a new
 * cadence without its time is half a schedule. `questions` present replaces
 * the whole selection.
 */
export const updateReportSchema = z
  .object({
    name: reportName.optional(),
    description: optionalText(2000),
    siteId: bigintText.optional(),
    stationIds: z.array(bigintText).max(200).optional(),
    presetKey: presetKey.nullable().optional(),
    analysisWindow: analysisWindow.optional(),
    schedule: scheduleSchema.optional(),
    timeOfDay: timeOfDay.optional(),
    questions: questionSelectionSchema.optional(),
  })
  .strict()
  .refine(
    (value) => (value.schedule === undefined) === (value.timeOfDay === undefined),
    { message: "Send the schedule and the time of day together." },
  );

export const reportStateActionSchema = z
  .object({ action: z.enum(["activate", "pause", "resume"]) })
  .strict();

/** A new owner for a report (Phase 3): an employee id. Eligibility is the service's question. */
export const transferOwnerSchema = z
  .object({ ownerEmployeeId: z.string().uuid("That is not an employee id.") })
  .strict();

export const personalQuestionSchema = z.object({ text: questionText }).strict();

/**
 * The module's safety ceiling (2026-11-12), either half or both. Dollars
 * to the cent, bounded as the database CHECK is; minutes bounded at 25 so
 * the worker job's 30-minute replica timeout is always above it with room
 * for the worker's own drain window.
 */
export const safetyCeilingSchema = z
  .object({
    ceilingUsd: z
      .number()
      .positive("The ceiling must be more than zero.")
      .max(MAX_CEILING_USD, "A ceiling above $1,000 is not a ceiling.")
      .multipleOf(0.01, "Enter whole cents.")
      .optional(),
    ceilingMinutes: z
      .number()
      .int("Enter whole minutes.")
      .min(1, "The time cap must be at least one minute.")
      .max(MAX_CEILING_MINUTES, "The time cap cannot be more than 25 minutes.")
      .optional(),
  })
  .strict()
  .refine((value) => value.ceilingUsd !== undefined || value.ceilingMinutes !== undefined, {
    message: "Send the ceiling in dollars, in minutes, or both.",
  });

/**
 * Adding a recipient. `confirmed` is the warn-and-confirm step for an
 * external address: the client sends it true only after the person has seen
 * the dialog. The service decides whether the address IS external; the
 * client's opinion of that is not sent.
 */
export const addRecipientSchema = z
  .object({
    email: z
      .string()
      .trim()
      .toLowerCase()
      .min(3)
      .max(254)
      .regex(EMAIL_SHAPE, "That is not an email address."),
    confirmed: z.boolean().optional(),
  })
  .strict();

export type CreateReportInput = z.infer<typeof createReportSchema>;
export type UpdateReportInput = z.infer<typeof updateReportSchema>;
export type ReportStateAction = z.infer<typeof reportStateActionSchema>["action"];
export type QuestionSelectionItem = z.infer<typeof questionSelectionItemSchema>;
export type QuestionSelection = z.infer<typeof questionSelectionSchema>;
export type PersonalQuestionInput = z.infer<typeof personalQuestionSchema>;
export type SafetyCeilingInput = z.infer<typeof safetyCeilingSchema>;
export type AddRecipientInput = z.infer<typeof addRecipientSchema>;
export type TransferOwnerInput = z.infer<typeof transferOwnerSchema>;
