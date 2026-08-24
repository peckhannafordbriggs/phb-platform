import type {
  CollectionHealth,
  PointExplorer,
  RollRisk,
  RunGap,
} from "@/lib/modules/bas/types";

/**
 * The browser's view of the Collection Health API, plus the pure functions that
 * decide how a number is coloured and how it reads.
 *
 * Separate from the component on purpose. `vitest.config.ts` runs in a `node`
 * environment with no DOM, so anything that has to be *proved* - and the colour
 * rules here have to be proved - lives in a plain module a test can import. See
 * tests/bas-health-ui.test.ts.
 */

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const BASE = "/api/modules/bas";

export async function fetchCollectionHealth(
  options: { days?: number; siteId?: string | null } = {},
  signal?: AbortSignal,
): Promise<CollectionHealth> {
  const params = new URLSearchParams();
  if (options.days !== undefined) params.set("days", String(options.days));
  // Absent, not "all": the server's default IS all, and sending a sentinel it
  // has to recognise is one more string to keep in step across two files.
  if (options.siteId != null) params.set("site", options.siteId);
  const suffix = params.toString();

  let response: Response;
  try {
    response = await fetch(
      `${BASE}/collection-health${suffix.length > 0 ? `?${suffix}` : ""}`,
      { signal, cache: "no-store" },
    );
  } catch (error) {
    // An aborted request is a navigation, not a failure worth showing.
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError("network", "Could not reach the server.");
  }

  const payload = (await response.json().catch(() => null)) as
    | { data?: CollectionHealth; error?: { code?: string; message?: string } }
    | null;

  if (!response.ok || payload?.error !== undefined) {
    throw new ApiError(
      payload?.error?.code ?? "unexpected",
      payload?.error?.message ?? "Something went wrong.",
    );
  }

  if (payload?.data === undefined) {
    throw new ApiError("unexpected", "The server returned nothing.");
  }

  return payload.data;
}

// --------------------------------------------------------------- controls

/**
 * The window presets.
 *
 * Three, matching the ranges anyone actually asks for: has it run since
 * yesterday, has it run this week, what has the month looked like. The service
 * accepts 1 to 90, so a wider range is one entry away, but a picker with eleven
 * options is a picker nobody reads.
 *
 * Grafana's dashboard opens on `now-7d`, so 7 is the default here too.
 */
export const WINDOW_PRESETS = [
  { days: 1, label: "24 hours" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
] as const;

export const DEFAULT_WINDOW_DAYS = 7;

/** "24 hours" for one day, because "1 days" is not a thing a person writes. */
export function windowLabel(days: number): string {
  const preset = WINDOW_PRESETS.find((option) => option.days === days);
  if (preset !== undefined) return preset.label;
  return days === 1 ? "24 hours" : `${days} days`;
}

/**
 * The sentence under the heading that says what is on screen.
 *
 * It is not decoration. Two controls change what every panel means, and a
 * reader who has forgotten which building is selected has no way to tell a real
 * zero from a filtered one. So the selection is restated in words next to the
 * data, not only in the controls that set it.
 */
export function describeScope(
  siteName: string | null,
  windowDays: number,
): string {
  const building = siteName ?? "All buildings";
  return `${building} · run history covers the last ${windowLabel(windowDays)}`;
}

/**
 * What the run list should say when it is empty.
 *
 * Three genuinely different states, and collapsing them is the failure this
 * whole screen is built to avoid: "the collector has never run" and "the
 * collector last ran four days ago and you are looking at 24 hours" both render
 * as an empty table, and only one of them is fine.
 */
export function describeEmptyRuns(
  newestRunAt: string | null,
  windowDays: number,
  siteName: string | null,
): string {
  const where = siteName === null ? "this database" : siteName;

  if (newestRunAt === null) {
    return `The collector has never recorded a run against ${where}. Either it has not been pointed here yet, or it has never started.`;
  }

  return `No collector runs in the last ${windowLabel(windowDays)}. The most recent one was ${formatTimestamp(newestRunAt)} — outside this window, so widen the range to see it.`;
}

// ---------------------------------------------------------------- colour

/**
 * Four tones, and only one of them is green.
 *
 * `neutral` exists so that "we have no answer" is expressible. Without it every
 * unknown has to borrow either green or red, and the one this screen exists to
 * prevent is an unknown borrowing green.
 */
export type Tone = "ok" | "warn" | "bad" | "neutral";

/**
 * The rule the whole screen turns on.
 *
 * `roll_horizon_unknown` means capacity has not been filled in from Workbench,
 * so we cannot compute how far back the station's history reaches and therefore
 * cannot tell whether it is overwriting records we never collected. **Unknown is
 * not safe.** docs/08 and the COMMENT on `bas_v_collection_health` both say it
 * in as many words, and tests/bas-health-ui.test.ts asserts it, because the
 * failure mode is a screen that is reassuring about the single condition it was
 * built to warn about.
 *
 * `never_collected` is the same shape of claim - a point we have never read is
 * not a healthy point - and gets the same treatment.
 */
export function basRiskTone(risk: RollRisk): Tone {
  switch (risk) {
    case "ok":
      return "ok";
    case "data_lost":
      return "bad";
    case "at_risk":
    case "roll_horizon_unknown":
    case "never_collected":
      return "warn";
  }
}

export const RISK_LABEL: Record<RollRisk, string> = {
  ok: "OK",
  at_risk: "At risk",
  data_lost: "Data lost",
  roll_horizon_unknown: "Horizon unknown",
  never_collected: "Never collected",
};

export const RISK_EXPLANATION: Record<RollRisk, string> = {
  ok: "Collected more recently than half the station's roll horizon.",
  at_risk:
    "More than half the roll horizon has passed since the last record we collected. Nothing is lost yet.",
  data_lost:
    "More time has passed than the station retains, so it has overwritten records we never collected. They are gone permanently.",
  roll_horizon_unknown:
    "Capacity or collection interval has not been filled in from Workbench, so the roll horizon cannot be computed and we cannot tell whether records are being lost.",
  never_collected: "No record has ever been collected for this point.",
};

/**
 * The tile thresholds, each one mirroring the corresponding Grafana panel.
 *
 * They are functions rather than inline conditions so a test can walk the
 * boundaries. Grafana's steps are inclusive from the step value up.
 */

/** Grafana: `colorMode: none`. A count with no opinion attached. */
export const activePointsTone = (): Tone => "neutral";

/** Grafana: `colorMode: none`. */
export const totalReadingsTone = (): Tone => "neutral";

/** Grafana: green at 0, orange from 1. Amber by design - a backlog, not a fault. */
export function unclassifiedTone(count: number): Tone {
  return count >= 1 ? "warn" : "ok";
}

/** Grafana: green at 0, red from 1. */
export function atRiskTone(count: number): Tone {
  return count >= 1 ? "bad" : "ok";
}

/**
 * Grafana: green under 30, orange from 30, red from 60.
 *
 * `null` - no readings at all - is neutral, never green. Zero minutes ago is the
 * healthiest possible answer and "we have never collected anything" is close to
 * the worst; rendering them the same colour is the empty-database version of the
 * unknown-is-not-safe bug.
 */
export function stalenessTone(minutes: number | null): Tone {
  if (minutes === null) return "neutral";
  if (minutes >= 60) return "bad";
  if (minutes >= 30) return "warn";
  return "ok";
}

/** A collector silence that outran the station's memory is not a warning. */
export function runGapTone(gap: RunGap | null): Tone {
  if (gap === null) return "neutral";
  return gap.exceedsRollHorizon ? "bad" : "neutral";
}

/**
 * The composition of the "points at risk" tile, worst first, zeroes dropped.
 *
 * The tile's total answers "is anything wrong"; this answers "what kind", which
 * is the difference between "go fill in capacity in Workbench" and "data is
 * being destroyed right now".
 */
export const RISK_SEVERITY_ORDER: readonly RollRisk[] = [
  "data_lost",
  "at_risk",
  "roll_horizon_unknown",
  "never_collected",
];

export function riskBreakdown(
  counts: Record<RollRisk, number>,
): Array<{ risk: RollRisk; count: number }> {
  return RISK_SEVERITY_ORDER.filter((risk) => counts[risk] > 0).map((risk) => ({
    risk,
    count: counts[risk],
  }));
}

// ------------------------------------------------------------- formatting

/** Thousands separators, because 5,519 and 55,19 are different at a glance. */
export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * A duration in minutes as something readable at every scale this screen sees:
 * ten minutes after a poll, and sixty-four hours after a laptop lid closed.
 */
export function formatMinutes(minutes: number | null): string {
  if (minutes === null) return "—";
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${Math.round(minutes)} min`;

  const hours = minutes / 60;
  if (hours < 48) {
    const wholeHours = Math.floor(hours);
    const rest = Math.round(minutes - wholeHours * 60);
    return rest === 0 ? `${wholeHours} h` : `${wholeHours} h ${rest} min`;
  }

  return `${(hours / 24).toFixed(1)} days`;
}

export function formatHours(hours: number | null): string {
  if (hours === null) return "—";
  if (hours < 48) return `${hours.toFixed(1)} h`;
  return `${(hours / 24).toFixed(1)} days`;
}

/**
 * A duration that is about to be compared against another duration.
 *
 * Keeps the hours and adds the days, because the comparison the reader has to
 * make is "64.3 h against a 41.7 h horizon". Rendered as "2.7 days against a
 * 41.7 h horizon" it needs arithmetic in the reader's head, and the whole point
 * of the sentence is that it should not.
 */
export function formatDurationAgainstHorizon(hours: number): string {
  const stated = `${hours.toFixed(1)} h`;
  return hours < 48 ? stated : `${stated} (${(hours / 24).toFixed(1)} days)`;
}

/**
 * Timestamps render in the reader's own zone, which is what Grafana's
 * `"timezone": "browser"` does. Every BAS timestamp is stored UTC (docs/08,
 * *Four invariants*); this is the display half of that and nothing more.
 *
 * The locale and zone are parameters so a test can pin them. Passing neither is
 * the browser default and is what the component does.
 */
export function formatTimestamp(
  value: string | null,
  locale?: string,
  timeZone?: string,
): string {
  if (value === null) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";

  return date.toLocaleString(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  });
}

/** Clock time only, for a chart axis where the date is already established. */
export function formatChartTick(
  ms: number,
  locale?: string,
  timeZone?: string,
): string {
  return new Date(ms).toLocaleString(locale, {
    month: "short",
    day: "numeric",
    timeZone,
  });
}

/**
 * The one-line summary of the longest collector silence in the window.
 *
 * Written as a sentence rather than a number because the point is the
 * consequence, not the duration: 64 hours means nothing to a reader who does not
 * already know the station keeps 41.7.
 */
export function describeRunGap(gap: RunGap | null): string | null {
  if (gap === null) return null;

  const duration = formatDurationAgainstHorizon(gap.hours);

  if (gap.rollHorizonHours === null) {
    return `The collector did not run for ${duration}. No roll horizon is known for any active point, so whether the station overwrote records during that time cannot be determined.`;
  }

  const horizon = formatHours(gap.rollHorizonHours);

  if (gap.exceedsRollHorizon) {
    return `The collector did not run for ${duration}, against a ${horizon} roll horizon. The station overwrote records during that silence and they are gone permanently.`;
  }

  return `The longest collector silence in this window was ${duration}, inside the ${horizon} roll horizon.`;
}

// ------------------------------------------------------- B4: Point Explorer

export async function fetchPointExplorer(
  options: { days?: number; siteId?: string | null; pointId?: string | null } = {},
  signal?: AbortSignal,
): Promise<PointExplorer> {
  const params = new URLSearchParams();
  if (options.days !== undefined) params.set("days", String(options.days));
  if (options.siteId != null) params.set("site", options.siteId);
  if (options.pointId != null) params.set("point", options.pointId);
  const suffix = params.toString();

  let response: Response;
  try {
    response = await fetch(
      `${BASE}/point-explorer${suffix.length > 0 ? `?${suffix}` : ""}`,
      { signal, cache: "no-store" },
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError("network", "Could not reach the server.");
  }

  const payload = (await response.json().catch(() => null)) as
    | { data?: PointExplorer; error?: { code?: string; message?: string } }
    | null;

  if (!response.ok || payload?.error !== undefined) {
    throw new ApiError(
      payload?.error?.code ?? "unexpected",
      payload?.error?.message ?? "Something went wrong.",
    );
  }

  if (payload?.data === undefined) {
    throw new ApiError("unexpected", "The server returned nothing.");
  }

  return payload.data;
}

/**
 * Is this sensor alive? Distinct-value count, NOT standard deviation.
 *
 * This was got wrong twice before it was got right, so the reasoning is here
 * rather than in a commit message. A threshold on sigma is unit-dependent -
 * "sigma below 0.5" means something different in degrees F, degrees C, percent
 * open and pascals - and it is untunable across buildings. It missed a sensor
 * frozen at 64.5 with sigma 0.08, because a stuck sensor has a LOW standard
 * deviation and so does a genuinely stable room.
 *
 * Distinct-value count is unit-independent. A live sensor sampling the physical
 * world produces many values whatever it measures; a dead one repeats a handful.
 * Live figures from this database: Temp1 gives 256 distinct across 286 readings
 * in 24 hours. A stuck sensor would give one or two.
 *
 * The thresholds are Grafana's, from panel 5 of the Point Explorer dashboard:
 * red below 4, amber 4 to 19, green from 20.
 */
export const DISTINCT_VALUES_AMBER = 4;
export const DISTINCT_VALUES_GREEN = 20;

export function distinctValuesTone(
  distinct: number,
  readings: number,
): Tone {
  // No readings at all is not a stuck sensor, it is no evidence. Rendering it
  // red would be as wrong as rendering it green.
  if (readings === 0) return "neutral";
  if (distinct >= DISTINCT_VALUES_GREEN) return "ok";
  if (distinct >= DISTINCT_VALUES_AMBER) return "warn";
  return "bad";
}

/** What the distinct-values tile says underneath the number. */
export function describeDistinctValues(
  distinct: number,
  readings: number,
): string {
  if (readings === 0) {
    return "No readings in this window, so there is nothing to judge.";
  }
  if (distinct >= DISTINCT_VALUES_GREEN) {
    return `${formatCount(distinct)} distinct values across ${formatCount(readings)} readings. A sensor sampling the physical world looks like this.`;
  }
  if (distinct >= DISTINCT_VALUES_AMBER) {
    return `Only ${formatCount(distinct)} distinct values across ${formatCount(readings)} readings. Worth a look - a sensor that has stopped responding repeats itself.`;
  }
  return `${formatCount(distinct)} distinct value${distinct === 1 ? "" : "s"} across ${formatCount(readings)} readings. This reads as a stuck sensor rather than a stable room.`;
}

/**
 * What the readings/nulls tile says.
 *
 * The tile exists to keep two things apart that both look like "no data":
 * a row with no populated value column is a RECORD the station returned empty -
 * a sensor fault - and no row at all means we never collected. docs/08, *A null
 * reading is not a missing reading*. Analysis that merges them reports equipment
 * shutdowns that never happened.
 */
export function describeNullRecords(
  readings: number,
  nullRecords: number,
): string {
  if (readings === 0) {
    return "No rows at all in this window. That is not the same as null readings - it means nothing was collected.";
  }
  if (nullRecords === 0) {
    return "Every row carries a value. A null record would mean the station logged an entry with nothing in it.";
  }
  return `${formatCount(nullRecords)} of ${formatCount(readings)} rows carry no value at all - the station logged an entry and had nothing to put in it. That is a sensor fault, not a missing row.`;
}

/**
 * The unit for an axis label, and the honest answer when there is not one.
 *
 * `points_RoomT` is fahrenheit; `Temp1` to `Temp3` carry no unit at all. The
 * chart plots one point at a time, so two units can never share an axis here -
 * but the label still has to say which of the two situations it is in, because
 * an unlabelled axis reads as "no unit needed" rather than "unit unknown".
 */
export function axisLabel(unit: string | null): string {
  return unit ?? "value (no unit recorded)";
}

/** A reading, at the precision the database rounds to. */
export function formatValue(value: number | null, unit: string | null): string {
  if (value === null) return "—";
  const rendered = value.toFixed(2);
  return unit === null ? rendered : `${rendered} ${unit}`;
}
