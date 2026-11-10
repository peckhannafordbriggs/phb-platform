import { z } from "zod";
import { ANALYSIS_WINDOWS, MAX_INTERVAL_DAYS } from "@/lib/modules/bas/reports/schedule";
import { EMAIL_SHAPE } from "@/lib/modules/bas/reports/recipients";

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

/**
 * Budget in dollars, to the cent. Capped well above anything a single run
 * should cost: a cap exists so that a runaway run stops, and a cap of a
 * thousand dollars is one that never will.
 */
const budgetUsd = z
  .number()
  .positive("The budget must be more than zero.")
  .max(1000, "A per-run budget above $1,000 is not a cap.")
  .multipleOf(0.01, "Enter whole cents.");

export const createReportSchema = z
  .object({
    name: reportName,
    description: optionalText(2000),
    siteId: bigintText,
    stationIds: z.array(bigintText).max(200).optional(),
    presetKey: presetKey.nullable().optional(),
    analysisWindow: analysisWindow.optional(),
    schedule: scheduleSchema,
    timeOfDay,
    budgetUsd: budgetUsd.optional(),
  })
  .strict();

/**
 * Edit carries only what changes. A key ABSENT leaves the field alone; a key
 * present with null clears what can be cleared (description, the preset).
 * `schedule` and `timeOfDay` travel together or not at all: a new cadence
 * without its time is half a schedule.
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
    budgetUsd: budgetUsd.optional(),
  })
  .strict()
  .refine(
    (value) => (value.schedule === undefined) === (value.timeOfDay === undefined),
    { message: "Send the schedule and the time of day together." },
  );

export const reportStateActionSchema = z
  .object({ action: z.enum(["activate", "pause", "resume"]) })
  .strict();

const questionText = z
  .string()
  .trim()
  .min(1, "Type the question.")
  .max(1000, "Questions are limited to 1,000 characters.");

/**
 * Adding one question. Three kinds, each naming exactly what it needs.
 * `saveToLibrary` on an inline question also saves the text to the viewer's
 * personal library and stores the question as a personal one.
 */
export const addReportQuestionSchema = z.discriminatedUnion("kind", [
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

export const reorderReportQuestionsSchema = z
  .object({
    questionIds: z.array(bigintText).min(1).max(200),
  })
  .strict();

export const personalQuestionSchema = z.object({ text: questionText }).strict();

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
export type AddReportQuestionInput = z.infer<typeof addReportQuestionSchema>;
export type ReorderReportQuestionsInput = z.infer<typeof reorderReportQuestionsSchema>;
export type PersonalQuestionInput = z.infer<typeof personalQuestionSchema>;
export type AddRecipientInput = z.infer<typeof addRecipientSchema>;
