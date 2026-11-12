import { BAS_LIBRARY_QUESTIONS } from "./library";

/**
 * The two presets (plan §A, "Standard report" and "Daily critical-site
 * preset", as changed on 2026-11-12). A preset is an ordered list of library
 * keys that one button in the editor ticks - and nothing more. Until
 * 2026-11-12 a preset report's questions were fixed and the question routes
 * refused to edit them; now every report's questions are a checklist, a
 * preset button ticks its set and unticks the other shared questions, and
 * the person ticks or unticks anything after. Nothing is locked.
 *
 * `preset_key` on a definition is a LABEL: which preset was last clicked,
 * kept while the report's shared questions still match that set and
 * cleared by the service as soon as they do not (`presetMatching`). It
 * restricts nothing.
 *
 * Data rather than rows: a preset is a decision about the product, the same
 * class as a tab in tabs.ts, and two presets do not justify a table. The
 * library rows they name ARE rows, so the expansion is looked up at write
 * time and the result stored on bas_report_questions like any other report's
 * questions - the engine reads one shape.
 */
export type PresetKey = "health_weekly" | "health_daily";

export interface ReportPreset {
  key: PresetKey;
  label: string;
  /** One line under the button in the editor. */
  description: string;
  /** Library keys in report order. */
  questionKeys: readonly string[];
}

const ALL_TWENTY = [...BAS_LIBRARY_QUESTIONS]
  .sort((a, b) => a.position - b.position)
  .map((q) => q.key);

export const REPORT_PRESETS: Readonly<Record<PresetKey, ReportPreset>> = {
  health_weekly: {
    key: "health_weekly",
    label: "Standard weekly health report",
    description:
      "Ticks the spec's twenty questions, so reports compare week to week and building to building. Tick or untick anything after.",
    questionKeys: ALL_TWENTY,
  },
  health_daily: {
    key: "health_daily",
    label: "Daily critical-site report",
    description:
      "Ticks Summary, Space Comfort and Data Health only, for hospitals and labs that get a daily run. Tick or untick anything after.",
    questionKeys: ALL_TWENTY.filter((key) => {
      const q = BAS_LIBRARY_QUESTIONS.find((row) => row.key === key);
      return q !== undefined && ["summary", "space_comfort", "data_health"].includes(q.section);
    }),
  },
};

export const PRESET_KEYS: readonly PresetKey[] = ["health_weekly", "health_daily"];

export function isPresetKey(value: string | null | undefined): value is PresetKey {
  return value === "health_weekly" || value === "health_daily";
}

export function presetLabel(key: string | null): string | null {
  return isPresetKey(key) ? REPORT_PRESETS[key].label : null;
}

/**
 * Whether a report's shared questions, as library keys in stored order, are
 * exactly a preset's set. Order-insensitive: the stored order is library
 * order, which is the preset's order, so comparing sets is comparing
 * sequences; and a person who unticks one question and ticks it again has
 * the same report. Custom questions (personal, typed) do not count against
 * a match - "the standard weekly plus two of mine" is still labelled by the
 * preset.
 */
export function presetMatching(libraryKeys: readonly string[], clicked: PresetKey | null): PresetKey | null {
  if (clicked === null) return null;
  const want = REPORT_PRESETS[clicked].questionKeys;
  if (want.length !== libraryKeys.length) return null;
  const have = new Set(libraryKeys);
  return want.every((key) => have.has(key)) && have.size === want.length ? clicked : null;
}
