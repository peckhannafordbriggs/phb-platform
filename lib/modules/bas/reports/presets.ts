import { BAS_LIBRARY_QUESTIONS } from "./library";

/**
 * The two locked presets (plan §A, "Standard report" and "Daily critical-site
 * preset"). A preset is a fixed, ordered list of library keys, selectable as
 * one unit and not editable: a report with a preset key holds exactly these
 * questions in exactly this order, and the question routes refuse to add,
 * remove or reorder on it (`preset_locked`). Variations are custom reports.
 *
 * Data rather than rows: a preset is a decision about the product, the same
 * class as a tab in tabs.ts, and two presets do not justify a table. The
 * library rows they name ARE rows, so the expansion is looked up at write
 * time and the result stored on bas_report_questions like any other report's
 * questions - Phase 2 reads one shape.
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
      "The spec's twenty questions in their fixed order, so reports compare week to week and building to building. Locked.",
    questionKeys: ALL_TWENTY,
  },
  health_daily: {
    key: "health_daily",
    label: "Daily critical-site report",
    description:
      "Summary, Space Comfort and Data Health only, for hospitals and labs that get a daily run. Locked.",
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
