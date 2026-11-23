"use client";

import { useMemo, useState } from "react";
import type {
  OutOfRange,
  PointExplorer as PointExplorerData,
  PointHistory,
  PointOption,
  TrendSampling,
} from "@/lib/modules/bas/types";
import { axisWords, lineStyle, type AxisSide } from "@/lib/modules/bas/chart-lines";
import {
  BREAKS_SHOWN_FIRST,
  describeBreakRule,
  describeBreaks,
  describeExpectedInterval,
  formatBreakHours,
  formatShare,
  longestBreaks,
  type BreaksSummary,
  type ExpectedInterval,
  type TrendBreak,
} from "@/lib/modules/bas/interval";
import type { TrendSummaryResult } from "@/lib/modules/bas/trend-summary/types";
import { unitSymbol } from "@/lib/modules/bas/units";
import { LineSwatch } from "./point-picker";
import type { ValueKind } from "@/lib/modules/bas/value-kind";
import { Button } from "@/components/ui";
import {
  ApiError,
  RISK_EXPLANATION,
  RISK_LABEL,
  basRiskTone,
  describeDistinctValues,
  describeEstimate,
  describeHorizon,
  distinctValuesTone,
  formatCount,
  formatHours,
  formatTimestamp,
  requestTrendSummary,
  type Tone,
} from "./health-client";
import { TONE_INK, TONE_STYLE, TONE_WASH } from "./tone";

/**
 * The pieces Point Explorer gained on 2026-11-20 - the Data health tile, the
 * breaks summary, the trend summary card and the legend of a chart of
 * several lines. Pure in their props, so tests render each one with a
 * fixture.
 */

// ----------------------------------------------------------- Data health

/**
 * The tile's tone: the stuck-sensor colour when the value is stuck (the
 * existing distinct-values rule, unchanged) or out of physical range, else
 * neutral. Missing data and the horizon are said in words, not in colour -
 * the at-risk colour belongs to a real roll risk, which is the horizon line.
 */
export function dataHealthTone(input: {
  distinctValues: number;
  readings: number;
  valueKind: ValueKind;
  outOfRange: OutOfRange | null;
}): Tone {
  const stuck = distinctValuesTone(input.distinctValues, input.readings, input.valueKind);
  if (stuck === "bad" || input.outOfRange !== null) return "bad";
  if (stuck === "warn") return "warn";
  return "neutral";
}

/** "Out of physical range: lowest -40 °F; a room or return air temperature reads 35 to 110 °F." */
export function describeOutOfRange(outOfRange: OutOfRange, unit: string | null): string {
  const symbol = unitSymbol(unit);
  const value = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1)}${symbol === null ? "" : ` ${symbol}`}`;
  const parts: string[] = [];
  if (outOfRange.lowest !== null && outOfRange.lowest < outOfRange.min) parts.push(`lowest ${value(outOfRange.lowest)}`);
  if (outOfRange.highest !== null && outOfRange.highest > outOfRange.max) parts.push(`highest ${value(outOfRange.highest)}`);
  return `Out of physical range: ${parts.join(", ")}; ${outOfRange.label} reads ${value(outOfRange.min)} to ${value(outOfRange.max)}.`;
}

/**
 * "History about 10 days (estimated: assumed 500 records × measured 30 min)".
 * Every number judged from an assumed capacity or a measured interval says so.
 */
export function describeHistoryLine(history: PointHistory): { text: string; tone: Tone; title: string } {
  const words = describeHorizon(history.horizon);
  const tone = basRiskTone(history.risk);
  const risk =
    history.risk === "data_lost" || history.risk === "at_risk" || history.risk === "short_horizon" || history.risk === "never_collected"
      ? ` — ${RISK_LABEL[history.risk].toLowerCase()}`
      : "";
  switch (history.horizon.state) {
    case "measured":
      return {
        text: `Station keeps ${words.label} of history (measured${history.horizon.capacitySource === "assumed" ? ", assumed capacity" : ""})${risk}`,
        tone,
        title: words.title,
      };
    case "configured":
      return { text: `Station keeps ${words.label} of history (from Workbench)${risk}`, tone, title: words.title };
    case "estimated":
      return {
        text: `Station keeps about ${formatHours(history.horizon.hours)} of history (${describeEstimate(history.horizon)})${risk}`,
        tone,
        title: words.title,
      };
    case "not_full":
      return {
        text: `History buffer not full yet${words.detail === null ? "" : ` · ${words.detail}`}`,
        tone,
        title: words.title,
      };
    case "unknown":
      return { text: "History size unknown", tone, title: RISK_EXPLANATION.roll_horizon_unknown };
  }
}

export function DataHealthTile({ data }: { data: PointExplorerData }) {
  const point = data.selectedPoint;
  if (point === null) return null;
  const { stats } = data;
  const tone = dataHealthTone({
    distinctValues: stats.distinctValues,
    readings: stats.readings,
    valueKind: point.valueKind,
    outOfRange: data.outOfRange,
  });
  const stuckTone = distinctValuesTone(stats.distinctValues, stats.readings, point.valueKind);
  const history = data.history === null ? null : describeHistoryLine(data.history);
  const missing = formatShare(data.breaks.missingShare);

  return (
    <div
      className="card tile-wash px-5 py-4 sm:col-span-2 lg:col-span-1"
      style={{ ...TONE_STYLE[tone], ...TONE_WASH[tone] }}
      data-testid="bas-data-health"
      data-tone={tone}
    >
      <p className="eyebrow text-[var(--muted)]">Data health</p>
      <p
        className="mt-1.5 font-display text-[2.125rem] font-semibold leading-none tabular-nums"
        style={{ color: TONE_INK[tone] }}
      >
        {missing === "none" ? "None missing" : `${missing} missing`}
      </p>
      <ul className="mt-2 space-y-0.5 text-xs leading-relaxed text-[var(--muted)]">
        <li data-testid="bas-expected-interval">{describeExpectedInterval(data.expectedInterval)}</li>
        {history !== null && (
          <li data-testid="bas-history-line" title={history.title} style={history.tone === "bad" ? { color: TONE_INK.bad } : undefined}>
            {history.text}
          </li>
        )}
        {/* The stuck-sensor rule and colour, unchanged, now a line of this tile. */}
        {(stuckTone === "bad" || stuckTone === "warn") && (
          <li data-testid="bas-stuck-warning" style={{ color: TONE_INK[stuckTone] }}>
            {formatCount(stats.distinctValues)} distinct value{stats.distinctValues === 1 ? "" : "s"}.{" "}
            {describeDistinctValues(stats.distinctValues, stats.readings, point.valueKind)}
          </li>
        )}
        {data.outOfRange !== null && (
          <li data-testid="bas-out-of-range" style={{ color: TONE_INK.bad }}>
            {describeOutOfRange(data.outOfRange, point.unit)}
          </li>
        )}
        {stats.nullRecords > 0 && (
          <li data-testid="bas-null-records">
            {formatCount(stats.nullRecords)} of {formatCount(stats.readings)} records logged with no value — a sensor fault, not a missing row.
          </li>
        )}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- breaks

/**
 * The breaks, said once: the summary line, the five longest, and the rest
 * behind "Show all". Replaces the one-line-per-break list, which on a point
 * nobody had entered an interval for was 280 lines a week.
 */
export function BreaksList({
  breaks,
  expected,
  timeZone,
  showing = null,
}: {
  breaks: BreaksSummary;
  expected: ExpectedInterval;
  timeZone: string | null;
  /** With several lines on the chart: the point these breaks are of. */
  showing?: string | null;
}) {
  const [showAll, setShowAll] = useState(false);
  const zone = timeZone ?? undefined;
  const longest = useMemo(() => longestBreaks(breaks.breaks), [breaks.breaks]);
  if (breaks.count === 0) return null;

  const row = (b: TrendBreak) => (
    <li key={`${b.fromMs}-${b.toMs}`} className="tabular-nums">
      {formatTimestamp(new Date(b.fromMs).toISOString(), undefined, zone)} →{" "}
      {b.ongoing === true ? "now" : formatTimestamp(new Date(b.toMs).toISOString(), undefined, zone)}
      {" — "}
      {formatBreakHours(b.hours)}
      {b.ongoing === true ? " (nothing since)" : ""}
    </li>
  );
  const listed = breaks.breaks.length;

  return (
    <div className="border-t border-[var(--divider-soft)] px-4 py-2.5 text-xs text-[var(--muted)]" data-testid="bas-breaks">
      <p className="font-medium text-[var(--foreground)]" data-testid="bas-breaks-summary">
        {describeBreaks(breaks, expected)}
      </p>
      {showing !== null && (
        <p className="mt-0.5" data-testid="bas-breaks-showing">
          showing {showing}
        </p>
      )}
      <p className="mt-0.5">A break is {describeBreakRule(expected)} — {describeExpectedInterval(expected).toLowerCase()}.</p>
      <p className="mt-2">{breaks.count > BREAKS_SHOWN_FIRST ? `The ${BREAKS_SHOWN_FIRST} longest:` : "Breaks:"}</p>
      <ul className="mt-0.5 space-y-0.5" data-testid="bas-breaks-longest">
        {longest.map(row)}
      </ul>
      {breaks.count > BREAKS_SHOWN_FIRST && (
        <>
          <button
            type="button"
            className="mt-2 underline decoration-dotted underline-offset-2 hover:text-[var(--foreground)]"
            aria-expanded={showAll}
            onClick={() => setShowAll((open) => !open)}
            data-testid="bas-breaks-toggle"
          >
            {showAll ? "Show fewer" : `Show all ${formatCount(breaks.count)}`}
          </button>
          {showAll && (
            <>
              <ul className="mt-1 max-h-72 space-y-0.5 overflow-auto" data-testid="bas-breaks-all">
                {breaks.breaks.map(row)}
              </ul>
              {listed < breaks.count && (
                <p className="mt-1">
                  The first {formatCount(listed)} are listed; the counts above are of all {formatCount(breaks.count)}.
                </p>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------- trend summary

/**
 * "Trend summary", between the tiles and the chart. Collapsed until asked:
 * nothing is requested, and nothing spent, until "Explain this trend" is
 * pressed. Then the sentences, the range they cover, when they were written,
 * whether they came from the cache, and Refresh - which writes a new one.
 */
export function TrendSummaryCard({
  data,
  request = requestTrendSummary,
  lines = 1,
}: {
  data: PointExplorerData;
  /** Injected by a test. */
  request?: typeof requestTrendSummary;
  /**
   * How many lines the chart holds. A summary is written from one point's
   * numbers, so with more than one the card says so and asks for nothing.
   */
  lines?: number;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<{ key: string; result: TrendSummaryResult } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const point = data.selectedPoint;
  if (point === null) return null;
  const several = lines > 1;
  const key = `${point.pointId}|${data.range.kind}|${data.range.days ?? ""}|${data.range.fromDate ?? ""}|${data.range.toDate ?? ""}`;
  // A result asked for another point or range is not shown under this one.
  const shown = answer !== null && answer.key === key ? answer.result : null;

  const ask = async (refresh: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const body =
        data.range.kind === "custom" && data.range.fromDate !== null && data.range.toDate !== null
          ? { point: point.pointId, from: data.range.fromDate, to: data.range.toDate, refresh }
          : { point: point.pointId, days: data.range.days ?? data.windowDays, refresh };
      const next = await request(body);
      setAnswer({ key, result: next });
      setOpen(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "The summary could not be written.");
    } finally {
      setBusy(false);
    }
  };

  const zone = shown?.timezone ?? data.range.timezone ?? undefined;

  return (
    <section className="card px-5 py-4" aria-label="Trend summary" data-testid="bas-trend-summary">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="eyebrow text-[var(--muted)]">Trend summary</h2>
        <div className="flex items-center gap-2">
          {shown !== null && !several && (
            <Button size="sm" onClick={() => setOpen((o) => !o)} ariaExpanded={open}>
              {open ? "Hide" : "Show"}
            </Button>
          )}
          {shown !== null && !several && shown.state !== "not_summarisable" && shown.state !== "no_data" && (
            <Button size="sm" disabled={busy} onClick={() => void ask(true)} testId="bas-trend-summary-refresh">
              {busy ? "Writing…" : "Refresh"}
            </Button>
          )}
          {(shown === null || several) && (
            <Button size="sm" variant="primary" disabled={busy || several || point.valueKind === "string"} onClick={() => void ask(false)} testId="bas-explain-trend">
              {busy ? "Reading the trend…" : "Explain this trend"}
            </Button>
          )}
        </div>
      </div>
      {several ? (
        <p className="mt-1 text-xs text-[var(--muted)]" data-testid="bas-trend-summary-several">
          A summary describes one point. With {lines} lines on the chart, plot one point to explain its trend.
        </p>
      ) : shown === null && error === null && (
        <p className="mt-1 text-xs text-[var(--muted)]">
          {point.valueKind === "string"
            ? "A text point has no trend to summarise."
            : "A few sentences on what this trend shows and anything worth a look, written from the numbers on this page."}
        </p>
      )}
      {error !== null && !several && (
        <p className="mt-2 rounded-[var(--radius-row)] border p-2 text-xs" style={TONE_STYLE.bad} role="alert">
          {error}
        </p>
      )}
      {shown !== null && open && !several && (
        <div className="mt-2" data-testid="bas-trend-summary-body">
          {shown.summary !== null ? (
            <p className="text-sm leading-relaxed">{shown.summary}</p>
          ) : (
            <p className="rounded-[var(--radius-row)] border p-2 text-xs" style={TONE_STYLE.warn} role="note">
              {shown.message}
            </p>
          )}
          <p className="mt-2 text-xs text-[var(--muted)]" data-testid="bas-trend-summary-meta">
            Covers {formatTimestamp(shown.rangeFrom, undefined, zone)} – {formatTimestamp(shown.rangeTo, undefined, zone)}
            {shown.generatedAt !== null && <> · written {formatTimestamp(shown.generatedAt, undefined, zone)}</>}
            {shown.cached ? " · saved summary, no new readings since" : shown.costUsd > 0 ? ` · $${shown.costUsd.toFixed(4)}` : ""}
            {shown.summary !== null && " · numbers checked against the data"}
          </p>
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------- the lines

/** The first two slots' strokes, by their old names: the point, and compare mode's purple. */
export const PRIMARY_STROKE = lineStyle(0).stroke;
export const COMPARE_STROKE = lineStyle(1).stroke;

/** One line as the legend shows it. */
export interface LegendLine {
  point: PointOption;
  slot: number;
  axis: AxisSide;
  sampling: TrendSampling;
}

/**
 * The legend above a chart of two or more lines: per line its dash and
 * colour, its name, what it reads in, which axis when there are two, that it
 * is averaged when it is, the JACE when the lines come from more than one,
 * and a remove button. The first line is the one the tiles describe. Text is
 * in the text colours; the swatch alone carries the line's colour.
 */
export function LinesLegend({
  lines,
  onRemove,
}: {
  lines: readonly LegendLine[];
  onRemove?: (pointId: string) => void;
}) {
  const twoAxes = lines.some((l) => l.axis === "right");
  const stations = new Set(lines.map((l) => l.point.stationId));
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 pb-1 pt-2 text-xs" data-testid="bas-lines-legend">
      {lines.map((line, i) => (
        <li key={line.point.pointId} className="inline-flex items-center gap-1.5" data-testid="bas-legend-line" data-point={line.point.pointId}>
          <LineSwatch slot={line.slot} />
          <span>{line.point.pointName}</span>
          <span className="text-[var(--muted)]">
            ({axisWords(line.point)}
            {twoAxes ? `, ${line.axis} axis` : ""}
            {line.sampling.kind === "bucketed" ? `, ${line.sampling.bucketLabel} averages` : ""}
            {stations.size > 1 ? `, ${line.point.stationName}` : ""}
            {i === 0 && lines.length > 1 ? ", in the tiles" : ""})
          </span>
          {onRemove !== undefined && lines.length > 1 && (
            <button
              type="button"
              aria-label={`Remove ${line.point.pointName} from the chart`}
              onClick={() => onRemove(line.point.pointId)}
              className="rounded px-1 text-[var(--muted)] hover:bg-[var(--neutral-100)] hover:text-[var(--foreground)]"
              data-testid="bas-legend-remove"
            >
              ×
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The comparison's value at a moment: the nearest sample within its own break rule, else nothing. */
export function comparisonValueAt(
  trend: PointExplorerData["trend"],
  atMs: number,
  withinMs: number,
): number | null {
  if (trend.length === 0) return null;
  let lo = 0;
  let hi = trend.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (trend[mid]!.tsMs < atMs) lo = mid + 1;
    else hi = mid;
  }
  let best: { d: number; v: number | null } | null = null;
  for (const i of [lo - 1, lo]) {
    const s = trend[i];
    if (s === undefined || s.isBreak) continue;
    const d = Math.abs(s.tsMs - atMs);
    if (best === null || d < best.d) best = { d, v: s.value };
  }
  return best === null || best.d > withinMs ? null : best.v;
}
