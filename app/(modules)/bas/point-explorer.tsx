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
  axisLabel,
  describeCappedExport,
  describeClockOffset,
  describeDistinctValues,
  describeExtentNotices,
  describeNoReadings,
  describeNullRecords,
  describeRange,
  describeSampling,
  distinctValuesTone,
  downloadPointReadingsCsv,
  fetchPointExplorer,
  formatChartTick,
  formatCount,
  formatHours,
  formatTimestamp,
  formatValue,
  type Tone,
} from "./health-client";
import { RangePicker } from "./range-picker";
import { ReadingsTable } from "./readings-table";
import {
  ALL_SITES,
  POINT_PARAM,
  PROJECT_PARAM,
  SITE_PARAM,
  STATION_PARAM,
  TABLE_VIEW,
  VIEW_PARAM,
  readFilters,
  withCascade,
  withFilter,
  withRange,
} from "./filters";
import { TONE_INK, TONE_STYLE, TONE_WASH } from "./tone";
import {
  formatAxisTick,
  formatStateBand,
  formatStateTick,
  formatStateTooltip,
  formatTooltipValue,
  stateAxis,
  valueAxis,
} from "./value-axis";
import { unitSymbol } from "@/lib/modules/bas/units";
import { stateWord, type BooleanStates } from "@/lib/modules/bas/value-kind";

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

  const { siteId, windowDays, range, pointId, projectId, stationId } = filters;
  // The trend panel as the chart (default) or the raw readings behind it.
  // In the URL like every other choice here; read by nothing on the server.
  const view: TrendView = searchParams.get(VIEW_PARAM) === TABLE_VIEW ? "table" : "chart";

  const load = useCallback(
    async (
      selection: {
        days: number;
        range: { from: string; to: string } | null;
        siteId: string | null;
        pointId: string | null;
        projectId: string | null;
        stationId: string | null;
      },
      options: { quiet?: boolean } = {},
    ) => {
      if (options.quiet !== true) setLoading(true);
      try {
        const next = await fetchPointExplorer(selection);
        setData(next);
        setError(null);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        const failure =
          caught instanceof ApiError
            ? caught
            : new ApiError("unexpected", "Something went wrong.");
        // A refused range is not a failed refresh. Keeping the previous chart
        // up under "showing the previous reading" would show last week's data
        // beneath a range control that says August; the refusal replaces it.
        if (failure.code === "validation_failed") setData(null);
        setError(failure);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // The range as two strings, so the effect's dependency is by value: a
  // fresh object from readFilters on every render would re-fetch every render.
  const rangeKey = range === null ? null : `${range.from}..${range.to}`;

  useEffect(() => {
    void load({ days: windowDays, range, siteId, pointId, projectId, stationId });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- range is keyed by rangeKey
  }, [load, windowDays, rangeKey, siteId, pointId, projectId, stationId]);

  // The ref carries the CURRENT selection, so a poll cannot revert the screen to
  // whatever was selected when the timer was installed.
  const pollRef = useRef<() => void>(() => {});
  pollRef.current = () => {
    void load(
      { days: windowDays, range, siteId, pointId, projectId, stationId },
      { quiet: true },
    );
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
  /** A cascade level: sets it and clears every level below, the point too. */
  const setCascade = (key: string, value: string | null) => {
    router.replace(`${pathname}${withCascade(searchParams, key, value)}`, {
      scroll: false,
    });
  };

  const setParam = (key: string, value: string | null) => {
    router.replace(`${pathname}${withFilter(searchParams, key, value)}`, {
      scroll: false,
    });
  };

  /** The time range: a preset, or two calendar dates. One writer for both. */
  const setRange = (next: { days: number } | { from: string; to: string }) => {
    router.replace(`${pathname}${withRange(searchParams, next)}`, { scroll: false });
  };

  if (loading && data === null) return <ExplorerSkeleton />;

  if (error !== null && data === null) {
    const refusedRange = error.code === "validation_failed" && range !== null;
    return (
      <section className="rounded border border-red-300 bg-red-50 p-6">
        <h2 className="text-sm font-medium text-red-900">
          {error.code === "bas_unavailable"
            ? "Building automation data is not available"
            : refusedRange
              ? "That date range cannot be shown"
              : "That did not load"}
        </h2>
        <p className="mt-1 text-sm text-red-900">{error.message}</p>
        {refusedRange ? (
          <button
            type="button"
            onClick={() => setRange({ days: windowDays })}
            className="mt-4 rounded border border-red-300 bg-white px-3 py-1.5 text-sm hover:bg-red-100"
          >
            Back to the last {windowDays === 1 ? "24 hours" : `${windowDays} days`}
          </button>
        ) : (
          <button
            type="button"
            onClick={() =>
              void load({ days: windowDays, range, siteId, pointId, projectId, stationId })
            }
            className="mt-4 rounded border border-red-300 bg-white px-3 py-1.5 text-sm hover:bg-red-100"
          >
            Try again
          </button>
        )}
      </section>
    );
  }

  if (data === null) return <ExplorerSkeleton />;

  const { stats, selectedPoint } = data;
  const unit = selectedPoint?.unit ?? null;
  // A boolean point's two state words; null for every other kind. Where this
  // is set, a reading is shown as its word and never as the 1 or 0 it travels
  // as - on the tiles here and on the chart's axis and tooltip below.
  const states = selectedPoint?.states ?? null;
  const reading = (value: number | null): string =>
    states === null ? formatValue(value, unit) : (stateWord(value, states) ?? "—");

  return (
    <div className="space-y-6">
      {/* ------------------------------------------------------- controls */}

      <div className="flex flex-wrap items-center gap-3">
        {/*
          Project -> Building -> JACE, and here they narrow WHICH POINTS ARE
          SELECTABLE: the point list below is built from the same intersection,
          so picking a JACE shortens the picker rather than just annotating the
          chart. Changing a level clears the ones under it, the point included -
          a point belongs to a station in a building, so narrowing above it can
          strand it.
        */}
        <Picker
          label="Project"
          value={data.selectedProjectId}
          onChange={(v) => setCascade(PROJECT_PARAM, v)}
          options={data.projects.map((row) => [row.projectId, row.name])}
        />
        <Picker
          label="Building"
          value={data.selectedSiteId}
          onChange={(v) => setCascade(SITE_PARAM, v)}
          options={data.sites.map((row) => [row.siteId, row.name])}
        />
        <Picker
          label="JACE"
          value={data.selectedStationId}
          onChange={(v) => setCascade(STATION_PARAM, v)}
          options={data.stations.map((row) => [row.stationId, row.name])}
        />

        <label className="flex items-center gap-2 text-sm">
          <span className="text-[var(--muted)]">Point</span>
          <select
            value={selectedPoint?.pointId ?? ""}
            onChange={(event) => setParam(POINT_PARAM, event.target.value)}
            disabled={data.points.length === 0}
            className="min-w-56 rounded border border-[var(--border)] bg-white px-2 py-1 text-sm disabled:opacity-50"
          >
            {data.points.length === 0 && <option value="">No points</option>}
            {/*
              Arrived from a Projects card (`?point=none`): the list is
              there and nothing is chosen. A disabled placeholder holds the
              empty value so the select does not display the first point as
              though it were selected. Choosing one writes `point=<id>`.
            */}
            {data.points.length > 0 && selectedPoint === null && (
              <option value="" disabled>
                Choose a point
              </option>
            )}
            {data.points.map((point) => (
              <option key={point.pointId} value={point.pointId}>
                {point.pointName}
                {point.pointRole === null ? "" : ` (${point.pointRole})`}
              </option>
            ))}
          </select>
        </label>

        <RangePicker
          range={data.range}
          calendar={data.calendar}
          onPreset={(days) => setRange({ days })}
          onCustom={(from, to) => setRange({ from, to })}
        />

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
        {states !== null
          ? `${states.on} / ${states.off}`
          : (unitSymbol(unit) ?? "no unit recorded")}
        {" · "}
        {describeRange(data.range)}
        {" · as of "}
        {formatTimestamp(data.observedAt, undefined, data.range.timezone ?? undefined)}
        {data.range.kind === "custom" && data.range.timezone !== null && (
          <>
            {" · "}
            <span data-testid="bas-range-zone">
              dates and times in {data.range.timezone}, the building&apos;s time zone
            </span>
          </>
        )}
      </p>
      {/*
        The station's clock, when it is measurably off. Said once, in the
        muted scope line rather than as a warning: it is a known separate
        problem (runbook.md, *A BAS station's clock is wrong*), nothing here
        corrects for it, and the one thing a person needs to know is that a
        range boundary will not line up with these readings exactly.
      */}
      {describeClockOffset(data.stationClockOffsetS, data.stationClockMeasuredAt) !== null && (
        <p className="-mt-4 text-xs text-[var(--muted)]" data-testid="bas-clock-note">
          {describeClockOffset(data.stationClockOffsetS, data.stationClockMeasuredAt)}
        </p>
      )}

      {selectedPoint === null ? (
        data.points.length > 0 ? (
          // Nothing loaded, by request: a Projects card lands here. Points
          // exist and the person picks one; nothing is drawn until they do.
          <section
            className="rounded border border-[var(--border)] p-8 text-center"
            data-testid="bas-choose-point"
          >
            <p className="text-sm font-medium">Choose a point</p>
            <p className="mt-1 text-sm text-[var(--muted)]">
              {data.points.length === 1 ? "1 point" : `${data.points.length} points`}
              {data.scope.label === null ? "" : ` in ${data.scope.label}`}
            </p>
          </section>
        ) : (
          <section className="rounded border border-[var(--border)] p-8 text-center">
            <p className="text-sm font-medium">No active points</p>
            <p className="mt-1 text-sm text-[var(--muted)]">
              {data.sites.length === 0
                ? "No buildings have been discovered yet."
                : "Nothing has been discovered on the station for this building, or every point is marked inactive."}
            </p>
          </section>
        )
      ) : (
        <>
          {/* ---------------------------------------------------- tiles */}

          <section
            aria-label="Point summary"
            className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5"
          >
            <Tile
              label="Latest"
              value={reading(stats.latest)}
              tone="neutral"
              // The one thing worth saying: this value may sit outside the
              // range the other tiles cover, so the timestamp is stated.
              detail={
                stats.latestAt === null
                  ? "This point has never produced a value."
                  : `${formatTimestamp(stats.latestAt)} · not limited to the range`
              }
            />
            <Tile
              label={`Average (${describeRange(data.range)})`}
              // A state has no average. The database's mean of 1s and 0s is a
              // share of readings, not of time, and a dash is truer than it.
              value={states !== null ? "—" : formatValue(stats.average, unit)}
              tone="neutral"
            />
            <Tile
              label="Range"
              value={
                stats.minimum === null || stats.maximum === null
                  ? "—"
                  : states !== null
                    ? formatStateBand(stats.minimum, stats.maximum, states)
                    : `${stats.minimum.toFixed(2)} – ${formatValue(stats.maximum, unit)}`
              }
              tone="neutral"
            />
            {/* Boolean: 1 or 2 is the healthy count, so the numeric thresholds do not apply (see the function). */}
            <Tile
              label="Readings / null records"
              value={`${formatCount(stats.readings)} / ${formatCount(stats.nullRecords)}`}
              tone={stats.nullRecords > 0 ? "warn" : "neutral"}
              detail={describeNullRecords(stats.readings, stats.nullRecords)}
            />
            <Tile
              label="Distinct values"
              value={formatCount(stats.distinctValues)}
              tone={distinctValuesTone(
                stats.distinctValues,
                stats.readings,
                selectedPoint.valueKind,
              )}
              detail={describeDistinctValues(
                stats.distinctValues,
                stats.readings,
                selectedPoint.valueKind,
              )}
            />
          </section>

          {/* ---------------------------------------------------- trend */}

          <TrendPanel
            data={data}
            unit={unit}
            view={view}
            onViewChange={(next) => setParam(VIEW_PARAM, next === "table" ? TABLE_VIEW : null)}
          />

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

/** Exported for tests/bas-unit-symbols.test.tsx, which renders one with a unit. */
export function Tile({
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
  count,
  description,
  actions,
  children,
}: {
  title: string;
  /** Rows in a scrolling body, beside the title, so nobody scrolls to count. */
  count?: number;
  description?: string;
  /** Small controls at the right of the heading: a toggle, a button. */
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="card overflow-hidden">
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-5 pb-3 pt-4">
        <div>
          <h2 className="font-display text-[0.8125rem] font-semibold uppercase tracking-[0.07em]">
            {title}
            {count !== undefined && (
              <span className="font-normal text-[var(--muted)]"> ({formatCount(count)})</span>
            )}
          </h2>
          {description !== undefined && description.length > 0 && (
            <p className="mt-1 text-xs text-[var(--muted)]">{description}</p>
          )}
        </div>
        {actions !== undefined && <div className="flex items-center gap-2">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

/** The trend panel's two faces. `chart` is the default and the URL's absent value. */
export type TrendView = "chart" | "table";

/** The Reset-zoom button's styling, shared by the view toggle and the download. */
const SMALL_BUTTON =
  "rounded border border-[var(--border)] bg-[var(--neutral-0)] px-2 py-0.5 text-[0.6875rem] hover:bg-[var(--neutral-100)] disabled:cursor-default disabled:opacity-40";

/**
 * Chart / Table. A pair of pressed-state buttons rather than a tab bar or a
 * checkbox: two words, no sentence, and the pressed one says where you are.
 */
function ViewToggle({
  view,
  onChange,
}: {
  view: TrendView;
  onChange: (view: TrendView) => void;
}) {
  const option = (value: TrendView, label: string) => (
    <button
      type="button"
      aria-pressed={view === value}
      onClick={() => onChange(value)}
      className={SMALL_BUTTON + (view === value ? " bg-[var(--neutral-100)] font-medium" : "")}
    >
      {label}
    </button>
  );
  return (
    <div role="group" aria-label="Show as" className="flex items-center gap-1">
      {option("chart", "Chart")}
      {option("table", "Table")}
    </div>
  );
}

/**
 * Save a fetched file through a temporary link. The one place the browser's
 * download machinery is touched; the fetch itself is in health-client.ts.
 */
function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
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
 * THREE mechanisms, because one is not enough to be noticed and two can still
 * be dismissed. This comment said "two" for a while and undercounted its own
 * code; the list below is what the component actually renders:
 *
 *  1. `connectNulls={false}` plus an explicit null sample inserted by
 *     `buildTrend` in the service. This is what actually stops the line.
 *  2. A shaded band over every gap, with its duration written on the panel
 *     header. A break alone can read as a rendering artifact; a labelled band
 *     cannot.
 *  3. A written list of every gap beneath the chart, with both timestamps and
 *     a duration. A band says where; only prose says how long, and only prose
 *     survives being described to somebody over the phone.
 *
 * All three are load-bearing and none is decoration. See
 * WHY-ITS-BUILT-THIS-WAY.md § 30.
 *
 * Custom ranges added three more sentences, each for a way a long range can
 * lie by omission: a notice when the readings were averaged into buckets and
 * what the band under the line is; a notice when the range starts before the
 * data or ends after it; and, in place of an empty chart, a sentence saying
 * there is nothing in the range and where the nearest data is. The recorded
 * gaps from `bas_data_gaps` are now drawn on the chart too, as dashed outlines
 * distinct from the bands derived from the readings.
 *
 * Exported so a test can render it with a bucketed payload and read the
 * notice back off the DOM.
 */
export function TrendPanel({
  data,
  unit,
  view = "chart",
  onViewChange,
}: {
  data: PointExplorerData;
  unit: string | null;
  /** Chart (default) or the raw readings behind it. */
  view?: TrendView;
  onViewChange?: (view: TrendView) => void;
}) {
  /**
   * The count and the longest are invisible from the chart; that the line stops
   * at a break is not - it is the thing you are looking at. No breaks needs no
   * sentence at all, and nothing here describes the shading.
   */
  const gapSummary =
    data.trendGaps.length === 0
      ? undefined
      : `${formatCount(data.trendGaps.length)} break${data.trendGaps.length === 1 ? "" : "s"} · longest ${formatHours(Math.max(...data.trendGaps.map((g) => g.hours)))}`;

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
   *
   * The state lives here and the chart is `TrendChart`, below, which takes the
   * zoom as a prop. That split is what lets a test render the chart at a zoom
   * narrow enough to reproduce the raw-float axis without a mouse.
   */
  const [zoom, setZoom] = useState<TrendZoom | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragTo, setDragTo] = useState<number | null>(null);

  /**
   * The table's total, lifted into the heading as "Readings (9,012)" - the
   * module's count-in-the-heading rule. Known only once the table has
   * fetched, which is only once it is shown.
   */
  const [tableTotal, setTableTotal] = useState<{ key: string; total: number } | null>(null);
  const tableKey = `${data.selectedPoint?.pointId ?? ""}|${data.range.from}|${data.range.to}`;
  const tableCount = tableTotal !== null && tableTotal.key === tableKey ? tableTotal.total : undefined;

  /**
   * Download CSV. Nothing is requested until the click; the response's
   * headers say how many rows the file holds against how many the range
   * holds, and when those differ the sentence below the heading says so, in
   * the warning tone. A clean export says nothing - the file arriving is the
   * message.
   */
  const [downloading, setDownloading] = useState(false);
  const [downloadNote, setDownloadNote] = useState<
    { tone: "warn" | "error"; text: string } | null
  >(null);

  async function downloadCsv(): Promise<void> {
    if (data.selectedPoint === null || downloading) return;
    setDownloading(true);
    setDownloadNote(null);
    try {
      const download = await downloadPointReadingsCsv({
        pointId: data.selectedPoint.pointId,
        from: data.range.from,
        to: data.range.to,
      });
      saveBlob(download.blob, download.filename);
      const capped = describeCappedExport(download);
      if (capped !== null) setDownloadNote({ tone: "warn", text: capped });
    } catch (caught) {
      setDownloadNote({
        tone: "error",
        text:
          caught instanceof ApiError
            ? `The download failed: ${caught.message}`
            : "The download failed. Try again.",
      });
    } finally {
      setDownloading(false);
    }
  }

  const panelActions =
    data.selectedPoint === null ? undefined : (
      <>
        <ViewToggle view={view} onChange={(next) => onViewChange?.(next)} />
        <button
          type="button"
          onClick={() => void downloadCsv()}
          disabled={downloading}
          className={SMALL_BUTTON}
          data-testid="bas-download-csv"
        >
          {downloading ? "Downloading…" : "Download CSV"}
        </button>
      </>
    );

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

  const selection: TrendZoom | null =
    dragFrom === null || dragTo === null
      ? null
      : { from: Math.min(dragFrom, dragTo), to: Math.max(dragFrom, dragTo) };

  const timeZone = data.range.timezone;
  const rangeMs = { fromMs: Date.parse(data.range.from), toMs: Date.parse(data.range.to) };
  const samplingNotice = describeSampling(data.sampling);
  const extentNotices = describeExtentNotices(
    data.range,
    data.pointExtent,
    data.stats.readings,
    // The same slack the line breaks on, so the notice and the break agree.
    Math.max((data.collectionIntervalS ?? 0) * 3, 900) * 1000,
  );
  const recordedGaps = data.dataGaps
    .map((gap) => ({
      fromMs: Date.parse(gap.gapStart),
      toMs: Date.parse(gap.gapEnd),
      cause: GAP_CAUSE_LABEL[gap.cause] ?? gap.cause,
    }))
    .filter((gap) => gap.toMs > rangeMs.fromMs && gap.fromMs < rangeMs.toMs);

  const noticeStyle = {
    color: "var(--phb-orange-ink)",
    borderColor: "color-mix(in srgb, var(--phb-orange) 45%, transparent)",
    background: "color-mix(in srgb, var(--phb-orange) 12%, transparent)",
  } as const;

  return (
    <Panel
      title={view === "table" ? "Readings" : "Trend"}
      count={view === "table" ? tableCount : undefined}
      description={view === "table" ? undefined : gapSummary}
      actions={panelActions}
    >
      {downloadNote !== null && (
        <p
          className={
            "border-b px-4 py-2 text-xs" +
            (downloadNote.tone === "error" ? " border-red-300 bg-red-50 text-red-900" : "")
          }
          style={downloadNote.tone === "warn" ? noticeStyle : undefined}
          role={downloadNote.tone === "error" ? "alert" : "note"}
          data-testid="bas-download-note"
        >
          {downloadNote.text}
        </p>
      )}
      {view === "table" && data.selectedPoint !== null ? (
        <ReadingsTable
          point={data.selectedPoint}
          range={data.range}
          extent={data.pointExtent}
          onTotal={(total) => setTableTotal({ key: tableKey, total })}
        />
      ) : data.trend.length === 0 ? (
        <p
          className="px-4 py-8 text-center text-sm text-[var(--muted)]"
          data-testid="bas-no-readings"
        >
          {data.selectedPoint === null
            ? "No point selected."
            : describeNoReadings(data.selectedPoint.pointName, data.range, data.pointExtent)}
          {data.range.kind === "preset" &&
            " Widen the range, or check Collection Health — this point may not be collecting at all."}
        </p>
      ) : (
        <>
          {/*
            The downsampling notice. Not collapsible, not a tooltip, not an
            icon: a sentence on the chart, in the warning tone, every time the
            readings were averaged. A chart that quietly averaged a -40 spike
            into a 74 is worse than no chart, because the person concludes
            nothing happened.
          */}
          {samplingNotice !== null && (
            <p
              className="border-b px-4 py-2 text-xs"
              style={noticeStyle}
              role="note"
              data-testid="bas-sampling-notice"
            >
              {samplingNotice}
            </p>
          )}
          {extentNotices.map((notice) => (
            <p
              key={notice}
              className="border-b px-4 py-2 text-xs"
              style={noticeStyle}
              role="note"
              data-testid="bas-extent-notice"
            >
              {notice}
            </p>
          ))}
          {/* Reset sits with the chart, and only exists once there is something to reset. */}
          {zoom !== null && (
            <div className="flex items-center gap-3 px-5 pb-1 pt-1 text-xs text-[var(--muted)]">
              <span>
                Zoomed to{" "}
                {formatTimestamp(new Date(zoom.from).toISOString(), undefined, timeZone ?? undefined)} –{" "}
                {formatTimestamp(new Date(zoom.to).toISOString(), undefined, timeZone ?? undefined)}
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

          <div className="h-[22rem] select-none px-3 pb-3 pt-1">
            {/*
              ResponsiveContainer hands its measured size to the chart through
              context, so the chart component in between needs no width or
              height of its own here. A test gives it both directly.
            */}
            <ResponsiveContainer width="100%" height="100%">
              <TrendChart
                trend={data.trend}
                gaps={data.trendGaps}
                recordedGaps={recordedGaps}
                unit={unit}
                states={data.selectedPoint?.states ?? null}
                zoom={zoom}
                range={rangeMs}
                timeZone={timeZone}
                sampled={data.sampling.kind === "bucketed"}
                selection={selection}
                onDragStart={setDragFrom}
                onDragMove={(at) => {
                  if (dragFrom !== null) setDragTo(at);
                }}
                onDragEnd={commitZoom}
              />
            </ResponsiveContainer>
          </div>

          {/*
            The written list of breaks: both timestamps and a duration, which
            is the one form that survives being read out over the phone. The
            recorded gaps get no sentence here - their outline on the chart
            carries the cause and a tooltip, and the table below lists them.
          */}
          {data.trendGaps.length > 0 && (
            <ul className="border-t border-[var(--border)] px-4 py-2.5 text-xs text-[var(--muted)]">
              {data.trendGaps.map((gap) => (
                <li key={gap.fromMs}>
                  No readings from{" "}
                  {formatTimestamp(new Date(gap.fromMs).toISOString(), undefined, timeZone ?? undefined)}{" "}
                  to {formatTimestamp(new Date(gap.toMs).toISOString(), undefined, timeZone ?? undefined)} —{" "}
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

/** A time range on the trend, in epoch milliseconds. */
export interface TrendZoom {
  from: number;
  to: number;
}

/** The axis and tooltip type size. One constant, because the gutter is sized from it. */
const CHART_FONT_SIZE = 11;

/**
 * The trend chart itself - everything inside the ResponsiveContainer.
 *
 * Exported so a test can render it at a chosen zoom with a fixed size. It has
 * no state: the zoom, the in-progress drag selection and the three drag
 * handlers all belong to `TrendPanel`.
 */
export function TrendChart({
  trend,
  gaps,
  recordedGaps = [],
  unit,
  states = null,
  zoom,
  range = null,
  timeZone = null,
  sampled = false,
  selection,
  onDragStart,
  onDragMove,
  onDragEnd,
  width,
  height,
  tooltipIndex,
}: {
  trend: PointExplorerData["trend"];
  gaps: PointExplorerData["trendGaps"];
  /**
   * Gaps from `bas_data_gaps` that touch the range - what the collector
   * recorded and explained, as opposed to `gaps`, which are derived from the
   * readings. Drawn as dashed outlines so the two cannot be confused.
   */
  recordedGaps?: Array<{ fromMs: number; toMs: number; cause: string }>;
  unit: string | null;
  /**
   * Set for a BOOLEAN point, and it changes what the chart IS: a stepped line
   * between two labelled states instead of a curve over a numeric axis. The
   * values in `trend` are 1 and 0 either way; these are the words they are
   * drawn as. Null for a numeric point. See value-kind.ts.
   */
  states?: BooleanStates | null;
  zoom: TrendZoom | null;
  /**
   * The range the data was asked for. Becomes the x domain when there is no
   * zoom, so a range that starts before the data shows the empty stretch
   * rather than starting the axis at the first reading and hiding it. Absent
   * (a test that only cares about the y-axis) the axis fits the data.
   */
  range?: { fromMs: number; toMs: number } | null;
  /** The building's zone for the tick labels and the tooltip. */
  timeZone?: string | null;
  /** Whether `value` is an average with `min`/`max` beside it. Names the tooltip rows. */
  sampled?: boolean;
  /** The drag in progress, or null when the pointer is up. */
  selection: TrendZoom | null;
  onDragStart: (atMs: number) => void;
  onDragMove: (atMs: number) => void;
  onDragEnd: () => void;
  /** Only a test sets these. In the page the ResponsiveContainer supplies both. */
  width?: number;
  height?: number;
  /**
   * Opens the tooltip on one sample without a pointer. Only a test sets it:
   * jsdom lays nothing out, so no synthetic mouse event can land on the plot,
   * and this is how the tooltip's wording gets asserted as rendered.
   */
  tooltipIndex?: number;
}) {
  const domain: [number, number] | ["dataMin", "dataMax"] =
    zoom !== null
      ? [zoom.from, zoom.to]
      : range !== null
        ? [range.fromMs, range.toMs]
        : ["dataMin", "dataMax"];

  const zone = timeZone ?? undefined;
  const spanMs =
    typeof domain[0] === "number" && typeof domain[1] === "number"
      ? domain[1] - domain[0]
      : trend.length > 1
        ? trend[trend.length - 1]!.tsMs - trend[0]!.tsMs
        : 0;

  /**
   * The y-axis is decided here, at EVERY zoom level, and handed to Recharts as
   * a list of ticks rather than a range.
   *
   * Recharts picks round ticks for a domain it derives itself, but given an
   * explicit domain - which a zoom is - it appends the raw endpoints as ticks
   * and stops rounding once the range is narrow. Zoomed to under a degree the
   * axis read "72.02734375", which is a genuine float32 reading and a useless
   * label, and the 56px gutter clipped it. So `valueAxis` chooses the ticks
   * from the values on screen, at a step no finer than the label's decimals,
   * formats every label with the decimals the point's unit calls for, and
   * sizes the gutter to the widest one. The domain IS the tick range, so the
   * two cannot disagree.
   *
   * The values on screen: the whole series at default zoom, the samples inside
   * the window otherwise. Nulls are skipped, not treated as zero - a null is an
   * absent reading, and folding it into the range would drag the axis to zero
   * and flatten everything real. Nothing about the data changes: `trend` is
   * plotted as delivered, float32 values and all.
   *
   * A bucketed sample contributes its MIN and MAX as well as its average. This
   * is what keeps an extreme on the axis: the lab sensor that went to -40 at
   * 09:05 on 24 August 2026 averages about 4 degF over that day, and an axis
   * fitted to averages alone would stop at zero and clip the band that
   * shows the -40. Drop `min`/`max` here and
   * tests/bas-range-chart.test.tsx fails.
   */
  const visibleValues = trend
    .filter(
      (point) =>
        zoom === null || (point.tsMs >= zoom.from && point.tsMs <= zoom.to),
    )
    .flatMap((point) => [point.value, point.min ?? null, point.max ?? null])
    .filter((value): value is number => value !== null);
  /**
   * A boolean point gets the state axis: two ticks at 0 and 1, labelled with
   * its words, whatever is on screen - a day that was "On" throughout still
   * shows both states, because an axis with one label is not an axis. The
   * numeric path above is not consulted for it, so no zoom level and no
   * bucket average can put a decimal on a state axis.
   */
  const axis =
    states !== null
      ? stateAxis(states, { fontSize: CHART_FONT_SIZE })
      : valueAxis(visibleValues, unit, { fontSize: CHART_FONT_SIZE });
  /**
   * A state holds until it changes, then jumps: `stepAfter`. A curve between
   * Off and On would draw the point half-occupied for a while, which is a
   * value it cannot have. Numeric points keep `monotone` - see the Area below.
   */
  const lineType = states !== null ? "stepAfter" : "monotone";

  return (
    <AreaChart
      data={trend}
      width={width}
      height={height}
      margin={{ top: 8, right: 12, bottom: 4, left: 4 }}
      onMouseDown={(e: { activeLabel?: string | number }) => {
        const at = Number(e?.activeLabel);
        if (Number.isFinite(at)) onDragStart(at);
      }}
      onMouseMove={(e: { activeLabel?: string | number }) => {
        const at = Number(e?.activeLabel);
        if (Number.isFinite(at)) onDragMove(at);
      }}
      onMouseUp={onDragEnd}
      onMouseLeave={onDragEnd}
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
      <CartesianGrid
        stroke="var(--neutral-200)"
        strokeDasharray="2 4"
        vertical={false}
      />
      <XAxis
        dataKey="tsMs"
        type="number"
        scale="time"
        // allowDataOverflow is what makes the domain a zoom rather
        // than a suggestion.
        allowDataOverflow
        domain={domain}
        tickFormatter={(ms: number) => formatChartTick(ms, undefined, zone, spanMs)}
        stroke="var(--muted)"
        tick={{ fontSize: CHART_FONT_SIZE }}
        minTickGap={48}
      />
      <YAxis
        stroke="var(--muted)"
        tick={{ fontSize: CHART_FONT_SIZE }}
        // Sized from the widest label, not a constant. See valueAxis.
        width={axis.width}
        domain={axis.domain}
        ticks={axis.ticks}
        // Every tick we chose is drawn. Recharts would otherwise thin the
        // list by its own measurement, and the list is already sized to fit.
        interval={0}
        tickFormatter={(value: number) =>
          states !== null
            ? formatStateTick(value, states)
            : formatAxisTick(value, axis.decimals)
        }
        // The rotated unit label. A boolean point has no unit and its states
        // ARE the axis, so it carries none rather than "no unit recorded".
        label={
          states !== null
            ? undefined
            : {
                value: axisLabel(unit),
                angle: -90,
                position: "insideLeft",
                style: { fontSize: CHART_FONT_SIZE, fill: "var(--muted)" },
              }
        }
      />
      <Tooltip
        defaultIndex={tooltipIndex}
        labelFormatter={(ms) =>
          typeof ms === "number"
            ? formatTimestamp(new Date(ms).toISOString(), undefined, zone)
            : ""
        }
        // One more decimal than the axis, with the unit. Still a display
        // choice: the value in the payload is the float32 reading itself.
        // A bucket's band arrives as [min, max] and is shown as such, so the
        // tooltip says what the band is rather than leaving it to be guessed.
        formatter={(value, name) => {
          // A boolean point: the state word, never the 1 or 0 behind it. A
          // bucket's band is the states seen in it; its value is the share
          // of readings that were on, said as such.
          if (states !== null) {
            if (Array.isArray(value)) {
              const [low, high] = value as [unknown, unknown];
              return [
                typeof low === "number" && typeof high === "number"
                  ? formatStateBand(low, high, states)
                  : "—",
                "states seen",
              ];
            }
            return [
              typeof value === "number" ? formatStateTooltip(value, states) : "—",
              name === "range" ? "states seen" : sampled ? "share of readings" : "state",
            ];
          }
          if (Array.isArray(value)) {
            const [low, high] = value as [unknown, unknown];
            return [
              typeof low === "number" && typeof high === "number"
                ? `${formatTooltipValue(low, unit)} – ${formatTooltipValue(high, unit)}`
                : "—",
              "lowest – highest",
            ];
          }
          return [
            typeof value === "number" ? formatTooltipValue(value, unit) : "—",
            name === "range" ? "lowest – highest" : sampled ? "average" : "reading",
          ];
        }}
        contentStyle={{
          fontSize: "0.75rem",
          border: "1px solid var(--border)",
          borderRadius: "0.625rem",
        }}
      />
      {/*
        Drawn before the Line so the shading sits underneath it. Each
        band covers a stretch with no readings at all.
      */}
      {gaps.map((gap) => (
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
      {/*
        The gaps the collector RECORDED, from bas_data_gaps. Usually they
        coincide with a derived band above - the same hole seen two ways -
        and sometimes they do not, which is exactly the case worth seeing.
        Outline only, longer dashes, the cause written inside: a recorded gap
        is a statement somebody made about the data, and it should look like
        one rather than like more shading.
      */}
      {recordedGaps.map((gap) => (
        <ReferenceArea
          key={`recorded-${gap.fromMs}-${gap.toMs}`}
          x1={gap.fromMs}
          x2={gap.toMs}
          ifOverflow="hidden"
          // The outline is drawn here rather than through the fill/stroke
          // props so that a <title> can sit on it: what the dashed outline
          // means is said on the outline itself, on hover, and nowhere else.
          shape={(props: { x?: number; y?: number; width?: number; height?: number }) => (
            <g className="recharts-reference-area-rect">
              <title>{`Recorded gap: ${gap.cause}. Listed in the table below.`}</title>
              <rect
                x={props.x}
                y={props.y}
                width={props.width}
                height={props.height}
                fill="none"
                stroke="var(--phb-maroon)"
                strokeOpacity={0.75}
                strokeDasharray="8 4"
              />
            </g>
          )}
          label={{
            value: gap.cause,
            position: "insideTop",
            fontSize: 10,
            fill: "var(--phb-maroon)",
          }}
        />
      ))}
      {/* The in-progress drag selection. */}
      {selection !== null && (
        <ReferenceArea
          x1={selection.from}
          x2={selection.to}
          fill="var(--module-accent, var(--phb-cyan))"
          fillOpacity={0.12}
          ifOverflow="hidden"
        />
      )}
      {/*
        The min-max band, drawn only when the trend is bucketed. This is the
        honest half of downsampling: the average line above it is smooth
        because averaging makes it so, and the band is where the readings
        actually went. A spike the average erased is a tooth in this band.
        Range areas take a [low, high] pair per sample; a break's null stays
        null so the band breaks where the line does.
      */}
      {sampled && (
        <Area
          type={lineType}
          name="range"
          dataKey={(point: PointExplorerData["trend"][number]) =>
            point.min != null && point.max != null ? [point.min, point.max] : null
          }
          stroke="none"
          fill="var(--module-accent, var(--phb-cyan))"
          fillOpacity={0.18}
          dot={false}
          activeDot={false}
          connectNulls={false}
          isAnimationActive={false}
        />
      )}
      <Area
        /*
          Curved, because a smooth line reads as a physical quantity
          rather than a set of measurements joined with a ruler.
          `monotone` specifically: it will not overshoot between
          samples, so the curve never draws a peak the sensor did not
          record. A boolean point steps instead - see `lineType`.
        */
        type={lineType}
        dataKey="value"
        name="value"
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
      count={gaps.length}
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
              {overwritten.length === 1 ? " is a station overwrite" : " are station overwrites"}:
              the data existed, the station destroyed it before we read it, and
              it cannot be recovered.
            </p>
          )}
          {/*
            The one scroll pattern, as on Collection Health: about seven rows,
            a sticky header, the count in the heading. The red line above
            stays outside the box so it cannot scroll away from the rows.
          */}
          <div className="max-h-72 overflow-auto">
            <table className="w-full min-w-[42rem] border-collapse text-sm">
              <thead className="sticky top-0 z-10 bg-[var(--surface)] text-left">
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


/**
 * One level of the Project -> Building -> JACE cascade.
 *
 * The same control as Collection Health's. Duplicated rather than shared
 * because the two screens style their control rows differently and a shared
 * component would have grown a `variant` prop to express that - which is more
 * coupling than twenty lines of select is worth.
 */
function Picker({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | null;
  options: Array<[string, string]>;
  onChange: (value: string | null) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-[var(--muted)]">{label}</span>
      <select
        value={value ?? ALL_SITES}
        onChange={(event) =>
          onChange(event.target.value === ALL_SITES ? null : event.target.value)
        }
        disabled={options.length === 0}
        className="rounded border border-[var(--border)] bg-white px-2 py-1 text-sm disabled:opacity-50"
      >
        <option value={ALL_SITES}>All</option>
        {options.map(([key, text]) => (
          <option key={key} value={key}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}
