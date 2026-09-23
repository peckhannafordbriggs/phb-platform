import { AT_RISK_ROLL_RISKS, atRiskCount, isAtRisk } from "@/lib/modules/bas/types";
import type {
  BasSettingsTree,
  CollectionHealth,
  Completeness,
  PointHorizon,
  InactiveReason,
  PointExplorer,
  PointExtent,
  PointHealthRow,
  RollRisk,
  RunGap,
  StationPointsList,
  TrendRange,
  TrendSampling,
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
  options: {
    days?: number;
    siteId?: string | null;
    projectId?: string | null;
    stationId?: string | null;
  } = {},
  signal?: AbortSignal,
): Promise<CollectionHealth> {
  const params = new URLSearchParams();
  if (options.days !== undefined) params.set("days", String(options.days));
  // Absent, not "all": the server's default IS all, and sending a sentinel it
  // has to recognise is one more string to keep in step across two files.
  if (options.siteId != null) params.set("site", options.siteId);
  if (options.projectId != null) params.set("project", options.projectId);
  if (options.stationId != null) params.set("station", options.stationId);
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

// ------------------------------------------------------------ custom range

/**
 * A `YYYY-MM-DD` as a person reads it - "14 Aug 2026" - with no time zone
 * conversion, because there is nothing to convert: it is a calendar date, and
 * the zone it belongs to is stated beside it.
 */
export function formatCalendarDate(date: string, locale?: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) return date;
  const [, y, m, d] = match;
  // Noon UTC, so that formatting in any zone on Earth lands on the same day.
  const noon = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), 12));
  return noon.toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * What the trend and the tiles cover, in words, with the zone named.
 *
 * "last 7 days" for a preset, as before. For a custom range the dates and the
 * zone: someone reading "14 Aug" needs to know it is 14 August where the
 * building is, not where they are. A single day is said once, not as "14 Aug
 * – 14 Aug".
 */
export function describeRange(range: TrendRange): string {
  if (range.kind === "preset" || range.fromDate === null || range.toDate === null) {
    return `last ${windowLabel(range.days ?? DEFAULT_WINDOW_DAYS)}`;
  }
  const zone = range.timezone === null ? "" : ` (${range.timezone})`;
  if (range.fromDate === range.toDate) {
    return `${formatCalendarDate(range.fromDate)}${zone}`;
  }
  return `${formatCalendarDate(range.fromDate)} – ${formatCalendarDate(range.toDate)}${zone}`;
}

/**
 * The sentence on the chart when the readings have been thinned. NEVER
 * omitted, never collapsible, and it says what was kept: a spike survives in
 * the band, not in the line.
 */
export function describeSampling(sampling: TrendSampling): string | null {
  if (sampling.kind === "raw") return null;
  return (
    `Averaged to one point per ${sampling.bucketLabel}: ${formatCount(sampling.readings)} ` +
    `readings are drawn as ${formatCount(sampling.buckets)} averages, because more than ` +
    `${formatCount(sampling.maxRaw)} readings would make the chart unusable. The shaded ` +
    `band is each ${sampling.bucketLabel}'s lowest and highest reading, so a spike stays ` +
    `visible when the average is flat.`
  );
}

/**
 * The empty state for a range that holds no readings. Names the range AND the
 * nearest data that does exist, so "nothing here" cannot be mistaken for
 * "nothing anywhere".
 */
export function describeNoReadings(
  pointName: string,
  range: TrendRange,
  extent: PointExtent,
): string {
  const where =
    range.kind === "custom" && range.fromDate !== null && range.toDate !== null
      ? range.fromDate === range.toDate
        ? `on ${formatCalendarDate(range.fromDate)}`
        : `between ${formatCalendarDate(range.fromDate)} and ${formatCalendarDate(range.toDate)}`
      : `in the ${describeRange(range)}`;
  const zone = range.timezone === null ? "" : ` (${range.timezone})`;
  if (extent.earliestAt === null || extent.latestAt === null) {
    return `No readings for ${pointName} ${where}${zone}. This point has never produced a reading.`;
  }
  return (
    `No readings for ${pointName} ${where}${zone}. The earliest reading held for this point ` +
    `is ${formatTimestamp(extent.earliestAt, undefined, range.timezone ?? undefined)} and the ` +
    `latest is ${formatTimestamp(extent.latestAt, undefined, range.timezone ?? undefined)}.`
  );
}

/**
 * The two notices for a range that reaches past the data at either end.
 *
 * Both exist for the same misreading: a chart that starts flat at the left
 * edge, or stops short of the right one, reads as the equipment being off or
 * the building being empty. It is neither. It is the collector not having
 * been there yet, or not any more.
 *
 * Slack at each end, so a range that ends "today" over a point collected ten
 * minutes ago does not claim the data has ended. The caller passes the
 * point's own break threshold.
 */
export function describeExtentNotices(
  range: TrendRange,
  extent: PointExtent,
  readings: number,
  slackMs: number,
): string[] {
  if (readings === 0 || extent.earliestAt === null || extent.latestAt === null) return [];
  const zone = range.timezone ?? undefined;
  const from = Date.parse(range.from);
  const to = Date.parse(range.to);
  const earliest = Date.parse(extent.earliestAt);
  const latest = Date.parse(extent.latestAt);
  const notices: string[] = [];
  if (earliest - from > slackMs) {
    notices.push(
      `Data for this point begins ${formatTimestamp(extent.earliestAt, undefined, zone)}. ` +
        `Nothing is drawn before that because nothing was collected, not because the equipment was off.`,
    );
  }
  if (to - latest > slackMs) {
    notices.push(
      `Data for this point ends ${formatTimestamp(extent.latestAt, undefined, zone)}. ` +
        `Nothing is drawn after that because nothing has been collected since.`,
    );
  }
  return notices;
}

/**
 * The one sentence about the station's clock, when it is measurably off.
 *
 * Nothing is corrected - runbook.md, *A BAS station's clock is wrong* - so
 * a range boundary will not line up with the readings by this much, and the
 * screen says so rather than letting someone conclude the range is wrong.
 * Under a minute it is not worth a sentence.
 */
export function describeClockOffset(
  offsetS: number | null,
  measuredAt: string | null,
): string | null {
  if (offsetS === null || Math.abs(offsetS) < 60) return null;
  const minutes = Math.round(Math.abs(offsetS) / 60);
  const direction = offsetS > 0 ? "ahead of" : "behind";
  const when = measuredAt === null ? "" : ` when last measured (${formatTimestamp(measuredAt)})`;
  return (
    `This station's clock was ${minutes} min ${direction} the collector${when}. ` +
    `Its readings are stamped by that clock and are not corrected, so a range boundary is off by the same amount.`
  );
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
    case "buffer_not_full":
      // Informational. Not amber - there is nothing to act on - and not
      // green either, because green here means "collected inside half a
      // known horizon" and this point has no horizon to be inside of.
      return "neutral";
  }
}

export const RISK_LABEL: Record<RollRisk, string> = {
  ok: "OK",
  at_risk: "At risk",
  data_lost: "Data lost",
  buffer_not_full: "Not full yet",
  roll_horizon_unknown: "Horizon unknown",
  never_collected: "Never collected",
};

export const RISK_EXPLANATION: Record<RollRisk, string> = {
  ok: "Collected more recently than half the station's roll horizon.",
  at_risk:
    "More than half the roll horizon has passed since the last record we collected. Nothing is lost yet.",
  data_lost:
    "More time has passed than the station retains, so it has overwritten records we never collected. They are gone permanently.",
  buffer_not_full:
    "The station holds fewer records than the history's capacity, so nothing has been overwritten. There is no horizon to measure until the buffer fills, and nothing to fill in.",
  roll_horizon_unknown:
    "No horizon is known: the history's capacity is not recorded, or the station reports no record count, so we cannot tell whether records are being lost. Fill in capacity from Workbench (History Ext Manager). Add the collection interval only for an interval trend - a change-of-value trend has none, and its horizon is measured once the buffer fills.",
  never_collected: "No record has ever been collected for this point.",
};

// ---------------------------------------------------------------- horizon

/**
 * One point's roll horizon, in words, for both screens that show one.
 *
 * Three distinct states, named distinctly (2026-09-18). The failure this
 * replaces was one word - "unknown" - covering a buffer nobody had measured,
 * a buffer that had never filled, and a buffer whose span had been measured
 * and then overwritten by a quieter afternoon's measurement.
 *
 *   measured     the guard horizon is the SHORTEST full-buffer span ever
 *                observed; the current span is said beside it when it differs.
 *   configured   capacity x interval, from Workbench.
 *   not_full     "Not full yet · 320 of 500". Nothing overwritten. Neutral.
 *                This text names no interval and sends nobody to Workbench,
 *                and tests/bas-health-ui.test.ts asserts that it never will.
 *   unknown      amber. Says what is missing, and tells the reader to fill
 *                in an interval ONLY for an interval trend.
 */
export function describeHorizon(horizon: PointHorizon): {
  label: string;
  detail: string | null;
  tone: Tone;
  title: string;
} {
  switch (horizon.state) {
    case "measured": {
      const current =
        horizon.currentHours === null
          ? "not full now"
          : formatHours(horizon.currentHours) === formatHours(horizon.hours)
            ? null
            : `now ${formatHours(horizon.currentHours)}`;
      return {
        label: formatHours(horizon.hours),
        detail: current === null ? "shortest seen" : `shortest seen · ${current}`,
        tone: "neutral",
        title:
          "Measured: the shortest span the station's full buffer has ever been seen to hold. " +
          "The guard and every risk figure use this, not today's span, because a change-of-value " +
          "point's span moves with how hard the equipment cycles - a point whose buffer has ever " +
          "spanned two hours is a two-hour point. The span the station reports today is shown beside it.",
      };
    }
    case "configured":
      return {
        label: formatHours(horizon.hours),
        detail: null,
        tone: "neutral",
        title: "Configured: capacity x collection interval, from Workbench.",
      };
    case "not_full":
      return {
        label: "Not full yet",
        detail:
          horizon.stationCount !== null && horizon.capacity !== null
            ? `${formatCount(horizon.stationCount)} of ${formatCount(horizon.capacity)}`
            : null,
        tone: "neutral",
        title: RISK_EXPLANATION.buffer_not_full,
      };
    case "unknown":
      return {
        label: "Unknown",
        detail: null,
        tone: "warn",
        title:
          horizon.capacity === null
            ? RISK_EXPLANATION.roll_horizon_unknown
            : "The station reports no record count for this history, so the buffer cannot be known to be full or not, and no horizon can be measured. Unknown is not safe.",
      };
  }
}

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

/**
 * What kind of problem the at-risk total is, which is not the same question as
 * how big it is.
 *
 *   losing   at least one point has data_lost - the station has already
 *            overwritten records nobody collected, and they are gone
 *   unknown  nothing is lost yet: the total is at_risk, roll_horizon_unknown
 *            and never_collected, which are "we cannot tell" and "not yet"
 *   none     zero
 *
 * The distinction is the difference between "go fill in capacity in Workbench"
 * and "data is being destroyed right now", and a single count cannot carry it.
 */
export type AtRiskShape = "none" | "losing" | "unknown";

export function atRiskShape(counts: Record<RollRisk, number>): AtRiskShape {
  const total = atRiskCount(counts);
  if (total === 0) return "none";
  return counts.data_lost > 0 ? "losing" : "unknown";
}

/**
 * Grafana had one step here: green at 0, red from 1. This is deliberately
 * stronger than the panel it mirrors.
 *
 * Red from one treats "capacity has not been filled in from Workbench" and "the
 * station has destroyed records we never read" as the same severity. The first
 * is a gap in what we know, the second is a permanent loss - and a screen that
 * shouts equally at both trains somebody to stop reading it.
 *
 * What has NOT changed is the rule this file exists for: above zero is never
 * `ok`. Unknown is not safe, and amber is its floor rather than its ceiling.
 */
export function atRiskTone(counts: Record<RollRisk, number>): Tone {
  switch (atRiskShape(counts)) {
    case "none":
      return "ok";
    case "unknown":
      return "warn";
    case "losing":
      return "bad";
  }
}

/**
 * The tile's headline, which has to say WHICH problem it is without anybody
 * decoding a stripe or a hue.
 *
 * "3 points, capacity unknown" and "3 points losing data" are different
 * sentences about the same number, and the number alone is the least useful part
 * of either.
 */
export function describeAtRisk(counts: Record<RollRisk, number>): string {
  const total = atRiskCount(counts);
  const points = `${formatCount(total)} point${total === 1 ? "" : "s"}`;

  switch (atRiskShape(counts)) {
    case "none":
      return "None at risk";
    case "losing":
      return counts.data_lost === total
        ? `${points} losing data`
        : `${formatCount(counts.data_lost)} of ${points} losing data`;
    case "unknown":
      return `${points}, capacity unknown`;
  }
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
 * being destroyed right now". Walks AT_RISK_ROLL_RISKS - the one list, which
 * is already in severity order - so the breakdown cannot name a state the
 * total does not count, or miss one it does. There used to be a second list
 * here; it agreed with the first by coincidence.
 */
export function riskBreakdown(
  counts: Record<RollRisk, number>,
): Array<{ risk: RollRisk; count: number }> {
  return AT_RISK_ROLL_RISKS.filter((risk) => counts[risk] > 0).map((risk) => ({
    risk,
    count: counts[risk],
  }));
}

/**
 * Active points that are actually reporting: the ones NOT at risk, by the one
 * predicate. Drives the "N of M reporting" badge on the Active points tile.
 *
 * Not "risk === ok". That was a third definition of the same question, and it
 * disagreed with the tile: a buffer that has never filled is not at risk, so
 * the tile said none at risk while this badge said two of eight reporting.
 * The badge and the tile must be the same claim, inverted.
 */
export function reportingPoints(points: readonly { risk: RollRisk }[]): number {
  return points.filter((point) => !isAtRisk(point.risk)).length;
}

// ---------------------------------------------------------- completeness

/**
 * The completeness check, surfaced.
 *
 * The collector (phb-bas) compares the station's own record count against
 * what the platform holds inside the station's span, every pass, and writes
 * the verdict to bas_sync_checkpoints. For a day it wrote it and nothing read
 * it - a detector for silent loss that was itself silent, which is the 28
 * August failure in a new coat. This is where the screen reads it.
 *
 * Severity follows the precedent this screen already sets. `incomplete` is
 * the station holding records we do not, after we asked for everything: not
 * lost yet, but the only thing between it and lost is the station's buffer
 * rolling, so it is red like data_lost. `backfilling` resolves itself - a
 * large first sync still paging - and is amber like an unclassified point or
 * a station awaiting its login (§ 43): visible, not alarming. `unknown` is
 * amber for the reason everything unknown on this screen is: it is not safe.
 */
export function completenessTone(completeness: Completeness): Tone {
  switch (completeness) {
    case "complete":
      return "ok";
    case "incomplete":
      return "bad";
    case "backfilling":
    case "unknown":
      return "warn";
  }
}

export const COMPLETENESS_LABEL: Record<Completeness, string> = {
  complete: "Complete",
  backfilling: "Backfilling",
  incomplete: "Incomplete",
  unknown: "Unchecked",
};

export const COMPLETENESS_EXPLANATION: Record<Completeness, string> = {
  complete:
    "The platform holds what the station reports holding for this point, within a few records.",
  backfilling:
    "The platform holds less than the station reports, and the last pass stopped at its request cap with pages still to fetch. The next pass continues. Expected during a large first sync.",
  incomplete:
    "The station reports records the platform does not have, after the collector asked for everything it holds. Nothing further arrives on its own. Not lost yet - the station still has them - but the only thing between this and lost is its buffer rolling.",
  unknown:
    "The station reported no record count for this history, or no collector pass has checked it yet. We cannot tell, and unknown is not safe.",
};

/** Worst first, `complete` excluded - what the completeness card lists. */
export const COMPLETENESS_SEVERITY_ORDER: readonly Completeness[] = [
  "incomplete",
  "backfilling",
  "unknown",
];

/**
 * The card's tone. Red from one incomplete point; amber when the only
 * shortfalls are self-resolving or unknowable; green only when every active
 * point has been checked and agrees with its station.
 */
export function completenessTileTone(counts: Record<Completeness, number>): Tone {
  if (counts.incomplete > 0) return "bad";
  if (counts.backfilling > 0 || counts.unknown > 0) return "warn";
  return "ok";
}

/** The card's headline: which problem, not just how many. */
export function describeCompleteness(counts: Record<Completeness, number>): string {
  const plural = (n: number) => `${formatCount(n)} point${n === 1 ? "" : "s"}`;
  if (counts.incomplete > 0) {
    return `${plural(counts.incomplete)} short of what the station holds`;
  }
  if (counts.backfilling > 0) {
    return `${plural(counts.backfilling)} still backfilling`;
  }
  if (counts.unknown > 0) {
    return `${plural(counts.unknown)} not yet checked against the station`;
  }
  return "Every point matches the station's own count";
}

export function completenessBreakdown(
  counts: Record<Completeness, number>,
): Array<{ completeness: Completeness; count: number }> {
  return COMPLETENESS_SEVERITY_ORDER.filter((c) => counts[c] > 0).map((c) => ({
    completeness: c,
    count: counts[c],
  }));
}

/** "500 on the station, 430 here" - the two numbers a shortfall is made of. */
export function describeShortfall(point: {
  stationCount: number | null;
  heldCount: number | null;
}): string {
  if (point.stationCount === null) return "station count unknown";
  if (point.heldCount === null) return `${formatCount(point.stationCount)} on the station`;
  return `${formatCount(point.stationCount)} on the station, ${formatCount(point.heldCount)} here`;
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
  /**
   * How much time the axis spans. Over about a year a tick needs its year -
   * "Aug 14" three times over on a three-year axis says nothing - and under
   * two days it needs its time of day. Absent, the day-and-month default.
   */
  spanMs?: number,
): string {
  if (spanMs !== undefined && spanMs > 400 * 86_400_000) {
    return new Date(ms).toLocaleString(locale, { month: "short", year: "numeric", timeZone });
  }
  if (spanMs !== undefined && spanMs > 0 && spanMs < 2 * 86_400_000) {
    return new Date(ms).toLocaleString(locale, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone,
    });
  }
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
    return `Silent for ${duration}. No roll horizon known, so the effect cannot be determined.`;
  }

  const horizon = formatHours(gap.rollHorizonHours);

  // The comparison IS the finding. What it means - the station overwrote what
  // nobody collected - is what the maroon tone and the gaps table are for, and
  // saying it here as well was telling the reader what the screen is for.
  if (gap.exceedsRollHorizon) {
    return `Silent for ${duration}, against a ${horizon} roll horizon.`;
  }

  return `Longest silence ${duration}, inside the ${horizon} roll horizon.`;
}

/**
 * Headroom: how long until the station starts overwriting data nobody collected.
 *
 * This is the BAS equivalent of the delta badge, and it is a different idiom on
 * purpose. A dashboard built around "+38% this week" is a COMPARISON system; the
 * question there is whether a number moved. BAS is a COUNTDOWN system - the
 * controller keeps roughly 42 hours and then overwrites - so the live question
 * is not "has this changed" but "how much time do we have".
 *
 * Per point: `rollHorizonHours` minus how long ago it was last collected. The
 * screen's headroom is the SMALLEST of those, because the first point to run out
 * is the one that decides when data starts being lost.
 *
 * THE RULE THAT MATTERS
 * --------------------
 * A point whose horizon is unknown contributes NOTHING and is counted separately.
 * `rollHorizonHours` is null for exactly the `roll_horizon_unknown` state, and
 * quietly computing the minimum over the points that do have one would produce a
 * clean, confident number that hides the very gap the screen exists to surface.
 * Unknown is not safe, and that applies to the badge as much as to the tile.
 *
 * So a partly-known set says so out loud - "38 h across 3 of 4 points, 1
 * unknown" - rather than "38 h".
 *
 * A point whose buffer has never filled (2026-09-18) also contributes nothing,
 * and is counted on its own line rather than as unknown: it has no horizon to
 * run out of, has overwritten nothing, and calling it unknown would put six
 * provably safe office points back in the amber it was just taken out of.
 */
export interface Headroom {
  /**
   * Hours until the earliest KNOWN point starts losing data. Negative means it
   * already is. Null when no point has a computable horizon.
   */
  hours: number | null;
  /** Points that contributed a number. */
  known: number;
  /** Points with no computable horizon, which contributed nothing. */
  unknown: number;
  /** Points whose buffer has never been seen full. Nothing to run out of. */
  notFull: number;
  /** Active points considered. */
  total: number;
}

export function computeHeadroom(points: PointHealthRow[]): Headroom {
  let hours: number | null = null;
  let known = 0;
  let unknown = 0;
  let notFull = 0;

  for (const point of points) {
    /**
     * Both halves are required for a number. A null horizon is a point with
     * nothing to count down; a null `minutesAgo` is a point never collected
     * at all, which has no "time since" to subtract. Treating either as zero
     * would invent a number.
     *
     * Which SHARE such a point joins is the at-risk question, and it is asked
     * of the one predicate: at risk -> "unknown" (a warning the badge must
     * carry); not at risk -> "not full yet" (nothing to run out of). This
     * badge used to decide that on its own from the horizon state, which is a
     * second definition of at-risk one refactor away from disagreeing with
     * the tile above it.
     */
    if (point.rollHorizonHours === null || point.minutesAgo === null) {
      if (isAtRisk(point.risk)) unknown += 1;
      else notFull += 1;
      continue;
    }

    known += 1;
    const remaining = point.rollHorizonHours - point.minutesAgo / 60;
    if (hours === null || remaining < hours) hours = remaining;
  }

  return { hours, known, unknown, notFull, total: points.length };
}

/**
 * The badge text. Never a bare number when part of the set is unknown.
 */
export function describeHeadroom(headroom: Headroom): string {
  const { hours, known, unknown, notFull, total } = headroom;

  if (total === 0) return "No active points";
  if (known === 0 && unknown === 0) {
    // Every point is below capacity. There is no horizon anywhere to run out
    // of, and "unknown" would be the wrong word for a set that is fully known.
    return `No buffer full yet (${formatCount(notFull)} of ${formatCount(total)})`;
  }
  if (known === 0) {
    return notFull === 0
      ? "Headroom unknown"
      : `Headroom unknown, ${formatCount(notFull)} not full yet`;
  }

  const measure =
    hours !== null && hours <= 0 ? "No headroom left" : `${formatHours(hours ?? 0)} headroom`;

  // Fully known: the number stands on its own.
  if (unknown === 0 && notFull === 0) return measure;

  // Partly known: the number is true of the points it covers and of no others,
  // and the sentence has to carry that or it is a false clean answer. A
  // not-full point is named as what it is, never folded into "unknown".
  const rest = [
    unknown > 0 ? `${unknown} unknown` : null,
    notFull > 0 ? `${notFull} not full yet` : null,
  ].filter((part) => part !== null);
  return `${measure} across ${known} of ${total} points, ${rest.join(", ")}`;
}

// ------------------------------------------------------- B4: Point Explorer

export async function fetchPointExplorer(
  options: {
    days?: number;
    /** A custom range wins over `days`; the two are never both sent. */
    range?: { from: string; to: string } | null;
    siteId?: string | null;
    pointId?: string | null;
    projectId?: string | null;
    stationId?: string | null;
  } = {},
  signal?: AbortSignal,
): Promise<PointExplorer> {
  const params = new URLSearchParams();
  if (options.range != null) {
    params.set("from", options.range.from);
    params.set("to", options.range.to);
  } else if (options.days !== undefined) {
    params.set("days", String(options.days));
  }
  if (options.siteId != null) params.set("site", options.siteId);
  if (options.pointId != null) params.set("point", options.pointId);
  if (options.projectId != null) params.set("project", options.projectId);
  if (options.stationId != null) params.set("station", options.stationId);
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
  if (readings === 0) return "Nothing to judge in this window.";

  const of = `Across ${formatCount(readings)} readings.`;

  // The denominator is invisible from the tile, and the low cases prevent a real
  // misreading: a flat line is a stable room OR a dead sensor, and they look
  // identical. The healthy case gets the denominator and nothing else.
  if (distinct >= DISTINCT_VALUES_GREEN) return of;
  if (distinct >= DISTINCT_VALUES_AMBER) {
    return `${of} A sensor that has stopped responding repeats itself.`;
  }
  return `${of} Reads as a stuck sensor, not a stable room.`;
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
  // Nothing to say when every row has a value - the numbers already said it.
  if (readings === 0) return "Nothing collected in this window.";
  if (nullRecords === 0) return "";

  // The one real misreading here: a null row looks like a missing row and is not.
  return `${formatCount(nullRecords)} of ${formatCount(readings)} rows logged with no value — a sensor fault, not a missing row.`;
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


/**
 * The Settings tree (B7.2).
 *
 * No parameters and no polling. The hierarchy changes when somebody changes it,
 * which in B7.2 is never - the two dashboards poll because collection moves on
 * its own, and this does not.
 *
 * A 404 here is the expected answer for a BAS user without the module-admin
 * flag, not a bug. The page above would already have 404'd, so a 404 from this
 * fetch means the grant was revoked while the tab was open, and `basSettingsUi`
 * says exactly that rather than showing an empty tree.
 */
export async function fetchBasSettings(
  query = "",
  signal?: AbortSignal,
): Promise<BasSettingsTree> {
  let response: Response;
  try {
    // The filters travel as a query string and are applied in SQL. Nothing is
    // filtered in this file: a screen that fetched every station and hid most
    // of them would have shipped the rows it claimed to exclude.
    response = await fetch(`${BASE}/settings${query}`, {
      signal,
      cache: "no-store",
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError("network", "Could not reach the server.");
  }

  if (response.status === 404) {
    throw new ApiError(
      "no_access",
      "You no longer have access to Building Automation settings.",
    );
  }

  const payload = (await response.json().catch(() => null)) as
    | { data?: BasSettingsTree; error?: { code?: string; message?: string } }
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
 * One station's points, loaded when the station is expanded (B8.2).
 *
 * Not part of the tree fetch on purpose: 26 points today, 600 per project
 * later, and the tree is fetched on every keystroke of the search box. The
 * count on the station row does not depend on this call - the tree carries a
 * direct count - so the row is right whether or not anyone expands it.
 */
export async function fetchStationPoints(
  stationId: string,
  signal?: AbortSignal,
): Promise<StationPointsList> {
  let response: Response;
  try {
    response = await fetch(
      `${BASE}/settings/stations/${encodeURIComponent(stationId)}/points`,
      { signal, cache: "no-store" },
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError("network", "Could not reach the server.");
  }

  if (response.status === 404) {
    // The station is gone, is not this employee's, or the grant is gone. One
    // answer for all three, by design - see station_not_found.
    throw new ApiError(
      "no_access",
      "That station is not available. It may have been removed, or you may no " +
        "longer have access to Building Automation settings.",
    );
  }

  const payload = (await response.json().catch(() => null)) as
    | { data?: StationPointsList; error?: { code?: string; message?: string } }
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
 * What the Points list says about a point that is not collected (B8.2, and
 * the reason column added the same day).
 *
 * The reason comes from bas_points.inactive_reason, written by the collector at
 * both places it deactivates a point and by a person otherwise. In plain words,
 * never the enum value: the person reading the row has no other way to look.
 * NULL still reads "reason not recorded", and nothing here derives a reason
 * from the point's name - that would be a second copy of the collector's rules.
 */
export const REASON_NOT_RECORDED = "reason not recorded";

/**
 * A total record, so adding a value to INACTIVE_REASONS without wording here
 * stops the build rather than rendering the enum.
 *
 * alarm_history is worded as what it is - building data waiting for a table -
 * and not as a system log, because filing it under the logs is how it would
 * never be revisited.
 */
export const INACTIVE_REASON_WORDS: Record<InactiveReason, string> = {
  niagara_system_log: "Niagara system log, not building data",
  alarm_history:
    "alarm history: real building data, excluded until it has a table of its own",
  reconfigured_cfg0: "retired half of a reconfigured _cfg0 pair",
  manual: "turned off by a person",
  no_longer_reported: "no longer reported by the station",
};

export function describeCollected(point: {
  collected: boolean;
  inactiveReason: InactiveReason | null;
}): {
  label: string;
  detail: string | null;
  tone: Tone;
} {
  if (point.collected) return { label: "Collected", detail: null, tone: "neutral" };
  // Neutral, not amber. Nine of the estate's 39 points are deliberately not
  // collected, and a list that turned amber on every station would be one
  // more alarm to learn to ignore. The completeness column is where a fault
  // shows. A point that is off with NO reason recorded is the one worth a
  // second look, and it is the one that reads differently.
  return {
    label: "Not collected",
    detail:
      point.inactiveReason === null
        ? REASON_NOT_RECORDED
        : INACTIVE_REASON_WORDS[point.inactiveReason],
    tone: "neutral",
  };
}

/**
 * A point's completeness as one word (B8.2), in the tones the Collection
 * Health card uses for the same states - see completenessTileTone.
 *
 * A point with no checkpoint row has never been passed by the collector at
 * all. For a collected point that is worth amber; for one that is not
 * collected it is the expected state and reads as nothing.
 */
export function describePointCompleteness(point: {
  collected: boolean;
  completeness: Completeness | null;
}): { label: string; tone: Tone } {
  if (point.completeness === null) {
    return point.collected
      ? { label: "Never collected", tone: "warn" }
      : { label: "\u2014", tone: "neutral" };
  }
  switch (point.completeness) {
    case "complete":
      return { label: "Complete", tone: "ok" };
    case "backfilling":
      return { label: "Backfilling", tone: "warn" };
    case "incomplete":
      return { label: "Incomplete", tone: "bad" };
    case "unknown":
      // Unknown is not green for a collected point. For one that is not
      // collected it is the only value it can hold, and colouring it would
      // say something about the point that is not true.
      return { label: "Not checked", tone: point.collected ? "warn" : "neutral" };
  }
}

/**
 * How one station's reach reads on screen, and in what tone.
 *
 * A plain function so `tests/bas-settings.test.ts` can prove it without a DOM -
 * the same reason every other rule in this file lives here rather than in the
 * component.
 *
 * `unconfigured` is amber and never green. It is a station that says its history
 * arrives through another station without saying which, which is what a JACE
 * linked in Workbench and never labelled here looks like. It may well be
 * collecting; nobody has said how. Rendering that as settled is the silent gap
 * this module keeps paying for.
 */
export function describeReach(station: {
  reach: string;
  baseUrl: string | null;
  parentStationName: string | null;
}): { label: string; detail: string; tone: Tone } {
  switch (station.reach) {
    case "direct":
      return {
        label: "Direct",
        detail: station.baseUrl ?? "no address recorded",
        tone: station.baseUrl === null ? "warn" : "ok",
      };
    case "via_parent":
      return {
        label: "Via parent",
        detail: `history imported by ${station.parentStationName ?? "?"}`,
        tone: "ok",
      };
    default:
      return {
        label: "Discovered, unassigned",
        detail: "no parent station recorded - nobody has said how this is reached",
        tone: "warn",
      };
  }
}


/**
 * The Settings write API (B7.3).
 *
 * One helper, because all five routes answer with the same envelope and the
 * same status vocabulary. The interesting statuses are 409 (a name collision,
 * or something that still has children under it) and 422 (validation) - both
 * carry a message written for the person on the screen, so the component shows
 * `error.message` rather than composing its own.
 *
 * A 404 from any of these is the module-admin grant having gone away mid-session,
 * not a missing row: the row ids came from the tree this page just loaded.
 */
async function settingsWrite<T>(
  path: string,
  init: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}/settings${path}`, {
      ...init,
      cache: "no-store",
      headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError("network", "Could not reach the server.");
  }

  if (response.status === 404) {
    throw new ApiError(
      "no_access",
      "You no longer have access to Building Automation settings.",
    );
  }

  const payload = (await response.json().catch(() => null)) as
    | { data?: T; error?: { code?: string; message?: string } }
    | null;

  if (!response.ok || payload?.error !== undefined) {
    throw new ApiError(
      payload?.error?.code ?? "unexpected",
      payload?.error?.message ?? "Something went wrong.",
    );
  }

  return payload?.data as T;
}

export const createProject = (body: {
  orgId: string;
  name: string;
  notes?: string | null;
}) =>
  settingsWrite<{ projectId: string }>("/projects", {
    method: "POST",
    body: JSON.stringify(body),
  });

export const updateProject = (
  projectId: string,
  body: { name?: string; notes?: string | null },
) =>
  settingsWrite<{ changed: boolean }>(
    `/projects/${encodeURIComponent(projectId)}`,
    { method: "PATCH", body: JSON.stringify(body) },
  );

export const deleteProject = (projectId: string) =>
  settingsWrite<{ deleted: boolean }>(
    `/projects/${encodeURIComponent(projectId)}`,
    { method: "DELETE" },
  );

export const createBuilding = (body: {
  projectId: string;
  name: string;
  timezone: string;
  address?: string | null;
}) =>
  settingsWrite<{ siteId: string }>("/buildings", {
    method: "POST",
    body: JSON.stringify(body),
  });

export const updateBuilding = (
  siteId: string,
  body: { name?: string; timezone?: string; address?: string | null },
) =>
  settingsWrite<{ changed: boolean }>(
    `/buildings/${encodeURIComponent(siteId)}`,
    { method: "PATCH", body: JSON.stringify(body) },
  );

export const deleteBuilding = (siteId: string) =>
  settingsWrite<{ deleted: boolean }>(
    `/buildings/${encodeURIComponent(siteId)}`,
    { method: "DELETE" },
  );

/**
 * Timezones offered in the building form.
 *
 * A convenience list, NOT the validation. The server checks against
 * `pg_timezone_names`, so a zone missing from here is still accepted if typed -
 * which is why the control is an input with a datalist rather than a select
 * that can only offer these six. Hardcoding a closed list would be a second
 * source of truth that goes stale the first time PH+B works outside these
 * zones.
 */
export const COMMON_TIMEZONES: readonly string[] = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "UTC",
];


// --------------------------------------------------------- stations (B7.4)

export interface StationPayload {
  siteId?: string;
  niagaraStationName?: string;
  displayName?: string | null;
  connectionMode?: "direct" | "via_parent";
  baseUrl?: string | null;
  parentStationId?: string | null;
  tlsSha256?: string | null;
  isActive?: boolean;
}

export const createStation = (body: StationPayload) =>
  settingsWrite<{ stationId: string }>("/stations", {
    method: "POST",
    body: JSON.stringify(body),
  });

export const updateStation = (stationId: string, body: StationPayload) =>
  settingsWrite<{ changed: boolean }>(
    `/stations/${encodeURIComponent(stationId)}`,
    { method: "PATCH", body: JSON.stringify(body) },
  );

export const deleteStation = (stationId: string) =>
  settingsWrite<{ deleted: boolean }>(
    `/stations/${encodeURIComponent(stationId)}`,
    { method: "DELETE" },
  );

/**
 * Show or hide a point on the browsing screens (B8.3). Never touches
 * collection: the payload has one field and it is not `isActive`.
 */
export const updatePointVisibility = (pointId: string, visible: boolean) =>
  settingsWrite<{ changed: boolean }>(
    `/points/${encodeURIComponent(pointId)}`,
    { method: "PATCH", body: JSON.stringify({ visible }) },
  );

/**
 * Replace the stored Niagara login.
 *
 * The password leaves the browser once and is never sent back. There is no
 * matching read function in this file, because there is no route to call: the
 * settings tree carries the username, whether a password is set, and when - and
 * nothing else exists to fetch.
 */
export const setStationCredential = (
  stationId: string,
  body: { username: string; password: string },
) =>
  settingsWrite<{ passwordSet: true }>(
    `/stations/${encodeURIComponent(stationId)}/credential`,
    { method: "PUT", body: JSON.stringify(body) },
  );

export const clearStationCredential = (stationId: string) =>
  settingsWrite<{ cleared: boolean }>(
    `/stations/${encodeURIComponent(stationId)}/credential`,
    { method: "DELETE" },
  );

/**
 * THE SENTENCE a station with no login stored shows on its card.
 *
 * The collector prints the identical sentence (phb-bas,
 * collector/targets.py, AWAITING_LOGIN) when it skips that station on a pass,
 * and its test reads THIS file and fails if the two drift. A person who reads
 * it in Settings on Friday and in the collector log on Monday should
 * recognise one state, not wonder whether two different things are wrong.
 */
export const AWAITING_LOGIN =
  "No login stored - this station will not be collected until one is set.";

/**
 * What a station's login situation means, if it means anything.
 *
 * `null` when there is nothing to say: the login is set, or the station is
 * reached through its parent and holds no login of its own.
 *
 * Two stations with no login stored are NOT the same state, and the tone says
 * so. One has never had a successful collector run - somebody registered it
 * and has not entered the password yet, which is the normal order of doing
 * things. That is amber, the same category as an unclassified point: a
 * visible backlog rather than a fault. Three stations registered on a Friday
 * afternoon must not read as three failures all weekend, because that is how
 * people learn to ignore red, and this is the one system where ignoring red
 * destroys data. The other WAS collecting and now cannot be. That is red.
 */
export function describeLogin(station: {
  reach: string;
  credential: unknown | null;
  activity: { everCollected: boolean };
}): { label: string; tone: Tone } | null {
  if (station.reach !== "direct" || station.credential !== null) return null;
  if (!station.activity.everCollected) {
    return { label: AWAITING_LOGIN, tone: "warn" };
  }
  return {
    label:
      "Login removed - this station was collecting and now cannot be. Set one to resume.",
    tone: "bad",
  };
}

/**
 * How a station's collection history reads on screen.
 *
 * This is what stands in for a "test connection" button. It is derived from
 * bas_ingest_runs and bas_sync_checkpoints - things the collector already
 * wrote - so it is equally true from a laptop on the building network and from
 * Azure, which cannot reach a JACE at all and never will.
 *
 * The newest RECORD is the headline, not the newest run: a run that completed
 * successfully while collecting nothing is not the same as data arriving, and
 * the difference is precisely the failure this module keeps finding late.
 */
export function describeActivity(activity: {
  lastRunAt: string | null;
  lastRunStatus: string | null;
  newestRecordAt: string | null;
}): { label: string; tone: Tone } {
  if (activity.newestRecordAt === null && activity.lastRunAt === null) {
    return { label: "Never collected", tone: "neutral" };
  }

  if (activity.newestRecordAt === null) {
    return {
      label: `Runs recorded, no data yet (last run ${activity.lastRunStatus ?? "unknown"})`,
      tone: "warn",
    };
  }

  const age = Date.now() - new Date(activity.newestRecordAt).getTime();
  const hours = age / 3_600_000;

  // The station keeps roughly 42 hours of history and then overwrites it. Past
  // that, whatever was not collected is gone - so the threshold is the roll
  // horizon and not a round number.
  if (hours > 42) {
    return {
      label: `Newest record ${formatTimestamp(activity.newestRecordAt)} - past the roll horizon`,
      tone: "bad",
    };
  }
  if (hours > 2) {
    return {
      label: `Newest record ${formatTimestamp(activity.newestRecordAt)}`,
      tone: "warn",
    };
  }
  return {
    label: `Collecting - newest record ${formatTimestamp(activity.newestRecordAt)}`,
    tone: "ok",
  };
}

// ---------------------------------------------------------------------------
// B8.3 - hidden points, and points the station stopped reporting
// ---------------------------------------------------------------------------

/**
 * The per-point table draws visible points only. A function rather than an
 * inline filter so the rule - hidden leaves the TABLE and never a total - can
 * be asserted without a DOM: the tiles read `health.totals`, which the service
 * computed over every active point, and this is the only place the list narrows.
 */
export function splitHiddenPoints<T extends { visible: boolean }>(
  points: readonly T[],
): { listed: T[]; hidden: T[] } {
  return {
    listed: points.filter((point) => point.visible),
    hidden: points.filter((point) => !point.visible),
  };
}

/** The line under the table when it is not drawing everything. Null when it is. */
export function describeHiddenFromTable(hidden: number): string | null {
  if (hidden <= 0) return null;
  return (
    `${formatCount(hidden)} hidden ${hidden === 1 ? "point is" : "points are"} not listed. ` +
    `Hidden points are still collected and still counted in every figure above; show ` +
    `${hidden === 1 ? "it" : "them"} again under Settings → Points.`
  );
}

/**
 * Points the collector turned off because the station stopped reporting them.
 *
 * Not "at risk": nothing is lagging a horizon, the history is gone from the
 * station, and no collector action fixes it. Not nothing either - amber from
 * one, because a deleted trend, a dropped device and a renamed history all look
 * exactly like this and only a person in Workbench can say which. Never the ok
 * tone above zero.
 */
export function vanishedTone(count: number): Tone {
  return count > 0 ? "warn" : "ok";
}

export function describeVanished(count: number, suffix: string): string {
  if (count === 0) {
    return (
      `No point has vanished from its station${suffix}. ` +
      `Every point that is not collected was turned off deliberately.`
    );
  }
  const one = count === 1;
  return (
    `${formatCount(count)} ${one ? "point is" : "points are"} no longer reported by ` +
    `${one ? "its station" : "their stations"}${suffix}. The collector turned ${one ? "it" : "them"} ` +
    `off and cannot tell why: a deleted trend, a dropped device or a renamed history all ` +
    `look like this. Check in Workbench.`
  );
}
