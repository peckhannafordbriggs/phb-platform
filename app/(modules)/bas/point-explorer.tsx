"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type {
  DataGapRow,
  PointExplorer as PointExplorerData,
} from "@/lib/modules/bas/types";
import {
  ApiError,
  WINDOW_PRESETS,
  axisLabel,
  describeDistinctValues,
  describeNullRecords,
  distinctValuesTone,
  fetchPointExplorer,
  formatChartTick,
  formatCount,
  formatHours,
  formatTimestamp,
  formatValue,
  windowLabel,
  type Tone,
} from "./health-client";
import { ALL_SITES, DAYS_PARAM, POINT_PARAM, SITE_PARAM, readFilters, withFilter } from "./filters";
import { TONE_INK, TONE_STYLE, TONE_WASH } from "./tone";

/**
 * Point Explorer - what one point has been doing.
 *
 * Mirrors the Grafana dashboard `bas-point-explorer.json`, which reads the same
 * live database. Where they disagree the screen is wrong; `npm run bas:oracle`
 * checks that panel by panel.
 *
 * ONE POINT AT A TIME, and that is a correctness decision rather than a scoping
 * one. `points_RoomT` is in fahrenheit; `Temp1` to `Temp3` carry no unit at all.
 * Two of those on one axis would put a temperature in F and a bare number on the
 * same line with nothing saying they are different quantities - which is how
 * 55 degF and 12.8 degC end up looking like the same reading. A single-point
 * chart cannot express that mistake, so it does not need to guard against it.
 */

const POLL_INTERVAL_MS = 60_000;


const GAP_CAUSE_LABEL: Record<string, string> = {
  roll_overwrite: "Station overwrote it",
  collector_down: "Collector was down",
  station_unreachable: "Station unreachable",
  point_added_later: "Point added later",
  station_clock_change: "Station clock changed",
  unknown: "Unknown",
};

export function PointExplorer() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filters = readFilters(searchParams);

  const [data, setData] = useState<PointExplorerData | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);

  const { siteId, windowDays, pointId } = filters;

  const load = useCallback(
    async (
      selection: { days: number; siteId: string | null; pointId: string | null },
      options: { quiet?: boolean } = {},
    ) => {
      if (options.quiet !== true) setLoading(true);
      try {
        const next = await fetchPointExplorer(selection);
        setData(next);
        setError(null);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        setError(
          caught instanceof ApiError
            ? caught
            : new ApiError("unexpected", "Something went wrong."),
        );
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void load({ days: windowDays, siteId, pointId });
  }, [load, windowDays, siteId, pointId]);

  // The ref carries the CURRENT selection, so a poll cannot revert the screen to
  // whatever was selected when the timer was installed.
  const pollRef = useRef<() => void>(() => {});
  pollRef.current = () => {
    void load({ days: windowDays, siteId, pointId }, { quiet: true });
  };

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const start = () => {
      if (timer !== null || document.visibilityState !== "visible") return;
      timer = setInterval(() => pollRef.current(), POLL_INTERVAL_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        pollRef.current();
        start();
      } else {
        stop();
      }
    };

    start();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", stop);
    window.addEventListener("focus", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", stop);
      window.removeEventListener("focus", onVisibility);
    };
  }, []);

  /**
   * Filter changes rewrite the URL, and the effect above reacts to it. The URL
   * is the state - see filters.ts - so this is the only place a selection is
   * recorded, and a refresh or a bookmark restores it for free.
   *
   * `replace` rather than `push`: changing a filter twenty times should not put
   * twenty entries in the back button. Tab links use a normal <Link>, so moving
   * between tabs IS in the history.
   */
  const setParam = (key: string, value: string | null) => {
    router.replace(`${pathname}${withFilter(searchParams, key, value)}`, {
      scroll: false,
    });
  };

  if (loading && data === null) return <ExplorerSkeleton />;

  if (error !== null && data === null) {
    return (
      <section className="rounded border border-red-300 bg-red-50 p-6">
        <h2 className="text-sm font-medium text-red-900">
          {error.code === "bas_unavailable"
            ? "Building automation data is not available"
            : "That did not load"}
        </h2>
        <p className="mt-1 text-sm text-red-900">{error.message}</p>
        <button
          type="button"
          onClick={() => void load({ days: windowDays, siteId, pointId })}
          className="mt-4 rounded border border-red-300 bg-white px-3 py-1.5 text-sm hover:bg-red-100"
        >
          Try again
        </button>
      </section>
    );
  }

  if (data === null) return <ExplorerSkeleton />;

  const { stats, selectedPoint } = data;
  const unit = selectedPoint?.unit ?? null;

  return (
    <div className="space-y-6">
      {/* ------------------------------------------------------- controls */}

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-[var(--muted)]">Building</span>
          <select
            value={data.selectedSiteId ?? ALL_SITES}
            onChange={(event) => setParam(SITE_PARAM, event.target.value)}
            disabled={data.sites.length === 0}
            className="rounded border border-[var(--border)] bg-white px-2 py-1 text-sm disabled:opacity-50"
          >
            <option value={ALL_SITES}>All</option>
            {data.sites.map((site) => (
              <option key={site.siteId} value={site.siteId}>
                {site.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-sm">
          <span className="text-[var(--muted)]">Point</span>
          <select
            value={selectedPoint?.pointId ?? ""}
            onChange={(event) => setParam(POINT_PARAM, event.target.value)}
            disabled={data.points.length === 0}
            className="min-w-56 rounded border border-[var(--border)] bg-white px-2 py-1 text-sm disabled:opacity-50"
          >
            {data.points.length === 0 && <option value="">No points</option>}
            {data.points.map((point) => (
              <option key={point.pointId} value={point.pointId}>
                {point.pointName}
                {point.pointRole === null ? "" : ` (${point.pointRole})`}
              </option>
            ))}
          </select>
        </label>

        <div
          className="flex items-center gap-2 text-sm"
          role="group"
          aria-label="Time range"
        >
          <span className="text-[var(--muted)]">Range</span>
          <div className="flex overflow-hidden rounded border border-[var(--border)]">
            {WINDOW_PRESETS.map((preset) => (
              <button
                key={preset.days}
                type="button"
                aria-pressed={data.windowDays === preset.days}
                onClick={() => setParam(DAYS_PARAM, String(preset.days))}
                className={
                  "border-l border-[var(--border)] px-2.5 py-1 text-sm first:border-l-0 " +
                  (data.windowDays === preset.days
                    ? "bg-[var(--accent)] text-white"
                    : "bg-white hover:bg-[var(--surface)]")
                }
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>

        {error !== null && (
          <p className="text-xs text-red-700" role="alert">
            The last refresh failed. Showing the previous reading.
          </p>
        )}
      </div>

      <p className="-mt-3 text-xs text-[var(--muted)]">
        {selectedPoint === null
          ? "No point selected"
          : `${selectedPoint.pointName} at ${selectedPoint.siteName}`}
        {" · "}
        {unit === null
          ? "no unit recorded for this point"
          : `values in ${unit}`}
        {" · last "}
        {windowLabel(data.windowDays)}
        {" · as of "}
        {formatTimestamp(data.observedAt)}
      </p>

      {selectedPoint === null ? (
        <section className="rounded border border-[var(--border)] p-8 text-center">
          <p className="text-sm font-medium">No active points</p>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {data.sites.length === 0
              ? "No buildings have been discovered yet."
              : "Nothing has been discovered on the station for this building, or every point is marked inactive."}
          </p>
        </section>
      ) : (
        <>
          {/* ---------------------------------------------------- tiles */}

          <section
            aria-label="Point summary"
            className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5"
          >
            <Tile
              label="Latest"
              value={formatValue(stats.latest, unit)}
              tone="neutral"
              detail={
                stats.latestAt === null
                  ? "This point has never produced a value."
                  : `Most recent value, from ${formatTimestamp(stats.latestAt)}. Not limited to the window.`
              }
            />
            <Tile
              label={`Average (last ${windowLabel(data.windowDays)})`}
              value={formatValue(stats.average, unit)}
              tone="neutral"
            />
            <Tile
              label="Range"
              value={
                stats.minimum === null || stats.maximum === null
                  ? "—"
                  : `${stats.minimum.toFixed(2)} – ${stats.maximum.toFixed(2)}`
              }
              tone="neutral"
            />
            <Tile
              label="Readings / null records"
              value={`${formatCount(stats.readings)} / ${formatCount(stats.nullRecords)}`}
              tone={stats.nullRecords > 0 ? "warn" : "neutral"}
              detail={describeNullRecords(stats.readings, stats.nullRecords)}
            />
            <Tile
              label="Distinct values"
              value={formatCount(stats.distinctValues)}
              tone={distinctValuesTone(stats.distinctValues, stats.readings)}
              detail={describeDistinctValues(stats.distinctValues, stats.readings)}
            />
          </section>

          {/* ---------------------------------------------------- trend */}

          <TrendPanel data={data} unit={unit} />

          {/* ----------------------------------------------------- gaps */}

          <GapTable
            gaps={data.dataGaps}
            pointName={selectedPoint.pointName}
          />
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ pieces

function Tile({
  label,
  value,
  tone,
  detail,
}: {
  label: string;
  value: string;
  tone: Tone;
  detail?: string;
}) {
  return (
    <div
      className="card tile-wash px-5 py-4"
      style={{ ...TONE_STYLE[tone], ...TONE_WASH[tone] }}
    >
      <p className="text-[0.625rem] font-medium uppercase tracking-[0.1em] text-[var(--muted)]">
        {label}
      </p>
      <p
        className="mt-1.5 font-display text-[2.125rem] font-semibold leading-none tabular-nums"
        style={{ color: TONE_INK[tone] }}
      >
        {value}
      </p>
      {detail !== undefined && detail.length > 0 && (
        <p className="mt-2 text-xs leading-relaxed text-[var(--muted)]">{detail}</p>
      )}
    </div>
  );
}

function Panel({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card overflow-hidden">
      <header className="px-5 pb-3 pt-4">
        <h2 className="font-display text-[0.8125rem] font-semibold uppercase tracking-[0.07em]">
          {title}
        </h2>
        {description !== undefined && description.length > 0 && (
          <p className="mt-1 text-xs text-[var(--muted)]">{description}</p>
        )}
      </header>
      {children}
    </section>
  );
}

/**
 * The trend, with the line BROKEN wherever there is no data.
 *
 * A line drawn straight across a gap asserts readings that were never taken. On
 * 21-22 August 2026 the station overwrote 22.7 hours of every point on this
 * site before the collector came back, and a straight segment across that hole
 * reads as a steady temperature - the most confident possible rendering of data
 * that was destroyed.
 *
 * Two mechanisms, because one is not enough to be noticed:
 *
 *  1. `connectNulls={false}` plus an explicit null sample inserted by
 *     `buildTrend` in the service. This is what actually stops the line.
 *  2. A shaded band over every gap, with its duration written on the panel
 *     header. A break alone can read as a rendering artifact; a labelled band
 *     cannot.
 */
function TrendPanel({
  data,
  unit,
}: {
  data: PointExplorerData;
  unit: string | null;
}) {
  /**
   * The count and the longest are invisible from the chart; that the line stops
   * at a break is not - it is the thing you are looking at. No breaks needs no
   * sentence at all.
   */
  const gapSummary =
    data.trendGaps.length === 0
      ? undefined
      : `${formatCount(data.trendGaps.length)} break${data.trendGaps.length === 1 ? "" : "s"}, shaded. Longest ${formatHours(Math.max(...data.trendGaps.map((g) => g.hours)))}.`;

  /**
   * Drag across the plot to zoom into a range; Reset goes back.
   *
   * The zoom is a DOMAIN change, never a change to the data. That distinction is
   * the whole safety of it: every sample stays in the array, including the
   * explicit nulls that break the line, so no zoom level can smooth over a gap
   * by filtering out the hole. The shaded bands are drawn from `trendGaps` at
   * every level too, clipped to the plot rather than dropped.
   *
   * Mouse only, and deliberately not the only way to narrow the view - the time
   * range control above does the same job for anyone not using a pointer.
   */
  const [zoom, setZoom] = useState<{ from: number; to: number } | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragTo, setDragTo] = useState<number | null>(null);

  const domain: [number, number] | undefined =
    zoom === null ? undefined : [zoom.from, zoom.to];

  /**
   * The y range of what is actually on screen.
   *
   * Recharts would otherwise keep scaling y to the whole window, so zooming into
   * a quiet stretch would show a flat line across the middle of a tall axis and
   * hide the very detail the zoom was for. Nulls are skipped, not treated as
   * zero - a null is an absent reading, and folding it into the range would drag
   * the axis to zero and flatten everything real.
   */
  const yDomain = ((): [number | "auto", number | "auto"] => {
    if (zoom === null) return ["auto", "auto"];

    const visible = data.trend
      .filter((point) => point.tsMs >= zoom.from && point.tsMs <= zoom.to)
      .map((point) => point.value)
      .filter((value): value is number => value !== null);

    if (visible.length === 0) return ["auto", "auto"];

    const min = Math.min(...visible);
    const max = Math.max(...visible);
    // A flat stretch would otherwise collapse to a zero-height band.
    const pad = max === min ? Math.max(Math.abs(max) * 0.05, 0.5) : (max - min) * 0.08;
    return [min - pad, max + pad];
  })();

  function commitZoom(): void {
    if (dragFrom === null || dragTo === null || dragFrom === dragTo) {
      setDragFrom(null);
      setDragTo(null);
      return;
    }

    setZoom({ from: Math.min(dragFrom, dragTo), to: Math.max(dragFrom, dragTo) });
    setDragFrom(null);
    setDragTo(null);
  }

  return (
    <Panel title="Trend" description={gapSummary}>
      {data.trend.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-[var(--muted)]">
          No readings in the last {windowLabel(data.windowDays)}. Widen the range,
          or check Collection Health — this point may not be collecting at all.
        </p>
      ) : (
        <>
          {data.trendTruncated && (
            <p
              className="border-b px-4 py-2 text-xs"
              style={{
                color: "var(--phb-orange-ink)",
                borderColor: "color-mix(in srgb, var(--phb-orange) 45%, transparent)",
                background: "color-mix(in srgb, var(--phb-orange) 12%, transparent)",
              }}
            >
              This window holds more samples than the chart will carry, so only
              the most recent part is drawn. Narrow the range to see a complete
              picture.
            </p>
          )}
          {/* Reset sits with the chart, and only exists once there is something to reset. */}
          {zoom !== null && (
            <div className="flex items-center gap-3 px-5 pb-1 pt-1 text-xs text-[var(--muted)]">
              <span>
                Zoomed to {formatTimestamp(new Date(zoom.from).toISOString())} –{" "}
                {formatTimestamp(new Date(zoom.to).toISOString())}
              </span>
              <button
                type="button"
                onClick={() => setZoom(null)}
                className="rounded border border-[var(--border)] bg-[var(--neutral-0)] px-2 py-0.5 text-[0.6875rem] hover:bg-[var(--neutral-100)]"
              >
                Reset zoom
              </button>
            </div>
          )}

          <div className="h-80 select-none px-3 pb-3 pt-1">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={data.trend}
                margin={{ top: 8, right: 12, bottom: 4, left: 4 }}
                onMouseDown={(e: { activeLabel?: string | number }) => {
                  const at = Number(e?.activeLabel);
                  if (Number.isFinite(at)) setDragFrom(at);
                }}
                onMouseMove={(e: { activeLabel?: string | number }) => {
                  if (dragFrom === null) return;
                  const at = Number(e?.activeLabel);
                  if (Number.isFinite(at)) setDragTo(at);
                }}
                onMouseUp={commitZoom}
                onMouseLeave={commitZoom}
              >
                <defs>
                  {/*
                    The wash under the line, in the module's cyan. It fades to
                    nothing well before the axis so it reads as depth rather than
                    as a filled region with a value of its own.
                  */}
                  <linearGradient id="basTrendFill" x1="0" y1="0" x2="0" y2="1">
                    <stop
                      offset="0%"
                      stopColor="var(--module-accent, var(--phb-cyan))"
                      stopOpacity={0.28}
                    />
                    <stop
                      offset="85%"
                      stopColor="var(--module-accent, var(--phb-cyan))"
                      stopOpacity={0}
                    />
                  </linearGradient>
                </defs>
                {/* Neutral grid, horizontal only. It is a reference, not a feature. */}
                <CartesianGrid stroke="var(--neutral-200)" vertical={false} />
                <XAxis
                  dataKey="tsMs"
                  type="number"
                  scale="time"
                  // allowDataOverflow is what makes the domain a zoom rather
                  // than a suggestion.
                  allowDataOverflow
                  domain={domain ?? ["dataMin", "dataMax"]}
                  tickFormatter={(ms: number) => formatChartTick(ms)}
                  stroke="var(--muted)"
                  tick={{ fontSize: 11 }}
                  minTickGap={48}
                />
                <YAxis
                  stroke="var(--muted)"
                  tick={{ fontSize: 11 }}
                  width={56}
                  domain={yDomain}
                  label={{
                    value: axisLabel(unit),
                    angle: -90,
                    position: "insideLeft",
                    style: { fontSize: 11, fill: "var(--muted)" },
                  }}
                />
                <Tooltip
                  labelFormatter={(ms) =>
                    typeof ms === "number"
                      ? formatTimestamp(new Date(ms).toISOString())
                      : ""
                  }
                  formatter={(value) => [
                    typeof value === "number" ? formatValue(value, unit) : "—",
                    "reading",
                  ]}
                  contentStyle={{
                    fontSize: "0.75rem",
                    border: "1px solid var(--border)",
                    borderRadius: "0.25rem",
                  }}
                />
                {/*
                  Drawn before the Line so the shading sits underneath it. Each
                  band covers a stretch with no readings at all.
                */}
                {data.trendGaps.map((gap) => (
                  <ReferenceArea
                    key={gap.fromMs}
                    x1={gap.fromMs}
                    x2={gap.toMs}
                    // Maroon, from the palette, and deliberately NOT the module
                    // accent: a gap is not sensor data and must not read as part
                    // of the series.
                    fill="var(--phb-maroon)"
                    fillOpacity={0.09}
                    stroke="var(--phb-maroon)"
                    strokeOpacity={0.4}
                    strokeDasharray="3 3"
                    // Clipped, not dropped: a gap half in view shows its half.
                    ifOverflow="hidden"
                  />
                ))}
                {/* The in-progress drag selection. */}
                {dragFrom !== null && dragTo !== null && (
                  <ReferenceArea
                    x1={Math.min(dragFrom, dragTo)}
                    x2={Math.max(dragFrom, dragTo)}
                    fill="var(--module-accent, var(--phb-cyan))"
                    fillOpacity={0.12}
                    ifOverflow="hidden"
                  />
                )}
                <Area
                  /*
                    Curved, because a smooth line reads as a physical quantity
                    rather than a set of measurements joined with a ruler.
                    `monotone` specifically: it will not overshoot between
                    samples, so the curve never draws a peak the sensor did not
                    record.
                  */
                  type="monotone"
                  dataKey="value"
                  // One accent, and it is the module's. Sensor data is the content.
                  stroke="var(--module-accent, var(--phb-cyan))"
                  strokeWidth={1.75}
                  fill="url(#basTrendFill)"
                  dot={false}
                  activeDot={{ r: 3 }}
                  /*
                    The whole point, and it survives the curve and every zoom
                    level. Recharts defaults this to false, but it is stated
                    because a future edit that flipped it would silently draw a
                    line across 22.7 hours of destroyed data. The curve joins
                    samples; it does not invent them across a null.
                  */
                  connectNulls={false}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {data.trendGaps.length > 0 && (
            <ul className="border-t border-[var(--border)] px-4 py-2.5 text-xs text-[var(--muted)]">
              {data.trendGaps.map((gap) => (
                <li key={gap.fromMs}>
                  No readings from {formatTimestamp(new Date(gap.fromMs).toISOString())}{" "}
                  to {formatTimestamp(new Date(gap.toMs).toISOString())} —{" "}
                  {formatHours(gap.hours)}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Panel>
  );
}

function GapTable({
  gaps,
  pointName,
}: {
  gaps: DataGapRow[];
  pointName: string;
}) {
  const overwritten = gaps.filter((gap) => gap.cause === "roll_overwrite");

  return (
    <Panel
      title="Known data gaps — periods we did not collect"
      // Same misreading, same one line, same wording as the health screen.
      description="A gap means we were not watching, not that equipment was off."
    >
      {gaps.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-[var(--muted)]">
          No gaps recorded for {pointName}.
        </p>
      ) : (
        <>
          {overwritten.length > 0 && (
            <p className="border-b border-red-300 bg-red-50 px-4 py-2.5 text-sm text-red-900">
              {formatCount(overwritten.length)} of these
              {overwritten.length === 1 ? " is" : " are"} a station overwrite: the
              data existed, the station destroyed it before we read it, and it
              cannot be recovered from anywhere.
            </p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[42rem] border-collapse text-sm">
              <thead className="bg-[var(--surface)] text-left">
                <tr>
                  <th className="px-3 py-2 font-medium">From</th>
                  <th className="px-3 py-2 font-medium">To</th>
                  <th className="px-3 py-2 text-right font-medium">Hours lost</th>
                  <th className="px-3 py-2 font-medium">Cause</th>
                  <th className="px-3 py-2 font-medium">Notes</th>
                </tr>
              </thead>
              <tbody>
                {gaps.map((gap) => (
                  <tr key={gap.gapId} className="border-t border-[var(--border)]">
                    <td className="px-3 py-2 text-[var(--muted)]">
                      {formatTimestamp(gap.gapStart)}
                    </td>
                    <td className="px-3 py-2 text-[var(--muted)]">
                      {formatTimestamp(gap.gapEnd)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {gap.hoursLost.toFixed(1)}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={
                          "inline-block rounded border px-1.5 py-0.5 text-xs font-medium " +
                          (gap.cause === "roll_overwrite"
                            ? "border-red-300 bg-red-50 text-red-900"
                            : "border-amber-300 bg-amber-50 text-amber-900")
                        }
                      >
                        {GAP_CAUSE_LABEL[gap.cause] ?? gap.cause}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-[var(--muted)]">
                      {gap.notes ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Panel>
  );
}

function ExplorerSkeleton() {
  return (
    <div className="space-y-6" aria-hidden="true">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <div
            key={i}
            className="rounded border border-[var(--border)] bg-[var(--surface)] p-4"
          >
            <div className="h-2.5 w-2/3 animate-pulse rounded bg-[var(--border)]" />
            <div className="mt-3 h-6 w-1/3 animate-pulse rounded bg-[var(--border)]" />
          </div>
        ))}
      </div>
      <div className="rounded border border-[var(--border)]">
        <div className="h-10 border-b border-[var(--border)] bg-[var(--surface)]" />
        <div className="h-72 animate-pulse bg-[var(--surface)]" />
      </div>
    </div>
  );
}
