/**
 * The shared arithmetic behind a "Usage & cost" page (2026-11-12): the three
 * ranges, the calendar days of a range in New York, and the row and day
 * shapes the shared usage components draw. Promoted from Cost Intelligence's
 * usage.ts when the BAS Reports Usage page was built on the same components;
 * each module keeps its own query over its own run table and hands these
 * shapes to components/ui/Usage.tsx.
 *
 * Days are America/New_York, the company's clock, whatever the viewer's.
 */

export const USAGE_RANGES = { "7d": 7, "30d": 30, "90d": 90 } as const;
export type UsageRange = keyof typeof USAGE_RANGES;

/** Anything not a known range falls back to 30 days. */
export const parseUsageRange = (raw: unknown): UsageRange =>
  typeof raw === "string" && Object.hasOwn(USAGE_RANGES, raw) ? (raw as UsageRange) : "30d";

export const USAGE_RANGE_OPTIONS: { value: UsageRange; label: string }[] = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
];

/** Spend in US dollars. `runs` counts runs that fell in the range. */
export type UsageRow = { label: string; runs: number; tokens: number; spend: number };
export type UsageDay = { date: string; label: string; spend: number };
export type UsageTotals = { runs: number; tokens: number; spend: number };
export type UsageMonth = { label: string; spend: number };

export const USAGE_ZONE = "America/New_York";
export const DAY_MS = 86_400_000;
const KEY = new Intl.DateTimeFormat("en-CA", { timeZone: USAGE_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
const SHORT = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
const MONTH = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long" });

/** YYYY-MM-DD in New York. */
export const dayKey = (at: Date) => KEY.format(at);

/** The calendar days of the range, oldest first, ending today. */
export function rangeDays(today: string, count: number): { date: string; label: string }[] {
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  return Array.from({ length: count }, (_, i) => {
    const day = new Date(Date.UTC(y, m - 1, d - (count - 1 - i)));
    return { date: day.toISOString().slice(0, 10), label: SHORT.format(day) };
  });
}

/** "October", from a YYYY-MM key. */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return MONTH.format(new Date(Date.UTC(y, m - 1, 1)));
}

/** A running tally keyed by label, counting distinct runs. */
export type Tally = Map<string, { label: string; runs: Set<string>; tokens: number; spend: number }>;

export function addToTally(tally: Tally, key: string, runId: string, tokens: number, spend: number): void {
  const row = tally.get(key) ?? { label: key, runs: new Set<string>(), tokens: 0, spend: 0 };
  row.runs.add(runId);
  row.tokens += tokens;
  row.spend += spend;
  tally.set(key, row);
}

/** The tally as rows, most spend first, ties by label. */
export const tallyRows = (tally: Tally): UsageRow[] =>
  [...tally.values()]
    .map((r) => ({ label: r.label, runs: r.runs.size, tokens: r.tokens, spend: r.spend }))
    .sort((a, b) => b.spend - a.spend || a.label.localeCompare(b.label));
