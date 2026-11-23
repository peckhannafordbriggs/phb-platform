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
  describeExtentNotices,
  describeNoReadings,
  describeRange,
  describeSampling,
  downloadPointReadingsCsv,
  fetchPointExplorer,
  formatChartTick,
  formatCount,
  formatTimestamp,
  formatValue,
  type Tone,
  describeStationPass,
  stationPickerOptions,
} from "./health-client";
import {
  BreaksList,
  DataHealthTile,
  LinesLegend,
  TrendSummaryCard,
  comparisonValueAt,
  type LegendLine,
} from "./point-explorer-parts";
import { AddPointPanel, EquipmentSelect, LineSwatch, PointList, pruneEquipment } from "./point-picker";
import { breakThresholdS, describeBreaks } from "@/lib/modules/bas/interval";
import {
  MAX_CHART_LINES,
  addSlot,
  lineStyle,
  removeSlot,
  slotIds,
  type AxisSide,
  type LineSlots,
} from "@/lib/modules/bas/chart-lines";
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
  chartSlots,
  readFilters,
  withCascade,
  withFilter,
  withLines,
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
import { Button, Dropdown, Segmented, type DropdownOption } from "@/components/ui";
import type { PointOption } from "@/lib/modules/bas/types";

/**
 * Point Explorer - what one point has been doing.
 *
 * Mirrors the Grafana dashboard `bas-point-explorer.json`, which reads the same
 * live database. Where they disagree the screen is wrong; `npm run bas:oracle`
 * checks that panel by panel.
 *
 * ONE POINT AT A TIME by default, and that was a correctness decision rather
 * than a scoping one. `points_RoomT` is in fahrenheit; `Temp1` to `Temp3` carry
 * no unit at all. Two of those on one axis would put a temperature in F and a
 * bare number on the same line with nothing saying they are different
 * quantities - which is how 55 degF and 12.8 degC end up looking like the same
 * reading.
 *
 * SEVERAL LINES (2026-11-20) keep that rule rather than dropping it: up to six
 * points from anywhere the viewer may see, a line sharing the left axis only
 * with the same quantity - the same recorded unit, or the same two state
 * words - the right axis for a second quantity, and no third axis at all
 * (lib/modules/bas/chart-lines.ts). The legend says which line is on which
 * axis; the tiles, the breaks and the gaps describe the first line and say
 * so. The URL carries the set (`point=` and `compare=`), so a chart is a link.
 *
 * THE PICKER (2026-11-20) replaced the Point dropdown, which listed 334
 * points in one column on CEI_JCI_N2: an Equipment multi-select after the
 * JACE, and a Point list grouped by equipment and searched by name or role
 * (point-picker.tsx).
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

  const { siteId, windowDays, range, pointId, projectId, stationId, compareSlots } = filters;
  // The other lines to load, in slot order, free slots skipped. Keyed by
  // value for the effect below, as the range is.
  const compareIds = slotIds(compareSlots);
  const compareKey = compareIds.join(",");

  /**
   * The picker's working state, which is not the chart's and stays out of the
   * URL: the equipment chosen, and whether the Point list is open. `null`
   * means "open exactly when no point is shown" - a Projects card lands with
   * the list open; a chart lands with it closed.
   */
  const [equipment, setEquipment] = useState<string[]>([]);
  const [listOpen, setListOpen] = useState<boolean | null>(null);
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
        compareIds: readonly string[];
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
    void load({ days: windowDays, range, siteId, pointId, projectId, stationId, compareIds });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- range and the lines are keyed by value
  }, [load, windowDays, rangeKey, siteId, pointId, projectId, stationId, compareKey]);

  // The ref carries the CURRENT selection, so a poll cannot revert the screen to
  // whatever was selected when the timer was installed.
  const pollRef = useRef<() => void>(() => {});
  pollRef.current = () => {
    void load(
      { days: windowDays, range, siteId, pointId, projectId, stationId, compareIds },
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

  /** The chart's lines, as slots. One writer: plot, add and remove all go through it. */
  const setLines = (slots: LineSlots) => {
    router.replace(`${pathname}${withLines(searchParams, slots)}`, { scroll: false });
  };

  if (loading && data === null) return <ExplorerSkeleton />;

  if (error !== null && data === null) {
    const refusedRange = error.code === "validation_failed" && range !== null;
    return (
      <section className="rounded-[var(--radius-pane)] border border-red-300 bg-red-50 p-6">
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
            className="mt-4 inline-flex h-9 items-center rounded-[var(--radius-control)] border border-red-300 bg-white px-4 text-[0.8125rem] font-medium hover:bg-red-100"
          >
            Back to the last {windowDays === 1 ? "24 hours" : `${windowDays} days`}
          </button>
        ) : (
          <button
            type="button"
            onClick={() =>
              void load({ days: windowDays, range, siteId, pointId, projectId, stationId, compareIds })
            }
            className="mt-4 inline-flex h-9 items-center rounded-[var(--radius-control)] border border-red-300 bg-white px-4 text-[0.8125rem] font-medium hover:bg-red-100"
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

  // The lines, as slots and as the points they are. A slot the server did not
  // draw (unavailable, or a third axis - said in its note) is not a line.
  const slots = chartSlots(filters, selectedPoint?.pointId ?? null);
  const drawn = new Set([selectedPoint?.pointId, ...data.comparisons.map((c) => c.point.pointId)]);
  const plotted: PointOption[] =
    selectedPoint === null ? [] : [selectedPoint, ...data.comparisons.map((c) => c.point)];
  const lineCount = plotted.length;
  const slotOf = (id: string): number | null => {
    const at = slots.indexOf(id);
    return at === -1 || !drawn.has(id) ? null : at;
  };
  const chosenEquipment = pruneEquipment(equipment, data.points);
  const open = listOpen ?? selectedPoint === null;

  return (
    <div className="space-y-6">
      {/* ------------------------------------------------------- controls */}

      <div className="flex flex-wrap items-center gap-3">
        {/*
          Project -> Building -> JACE, and here they narrow WHICH POINTS ARE
          SELECTABLE: the Equipment options and the Point list are built from
          the same intersection. Changing a level clears the ones under it and
          every line - a point belongs to a station in a building, so narrowing
          above it can strand it.
        */}
        <Picker
          label="Project"
          value={data.selectedProjectId}
          onChange={(v) => setCascade(PROJECT_PARAM, v)}
          options={data.projects.map((row) => ({ value: row.projectId, label: row.name }))}
        />
        <Picker
          label="Building"
          value={data.selectedSiteId}
          onChange={(v) => setCascade(SITE_PARAM, v)}
          options={data.sites.map((row) => ({ value: row.siteId, label: row.name }))}
        />
        <Picker
          label="JACE"
          value={data.selectedStationId}
          onChange={(v) => setCascade(STATION_PARAM, v)}
          // Tree order: a via-parent JACE indented under the JACE whose
          // import carries it, its own last pass beside it (2026-11-20).
          options={stationPickerOptions(data.stations)}
        />
        <EquipmentSelect
          points={data.points}
          value={chosenEquipment}
          onChange={(next) => {
            setEquipment(next);
            // Choosing equipment is choosing what to look through: open the list.
            setListOpen(true);
          }}
        />

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
        {lineCount > 1 && ` and ${lineCount - 1} more line${lineCount === 2 ? "" : "s"}`}
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
      {new Set(plotted.map((p) => p.stationId)).size > 1 && (
        <p className="-mt-4 text-xs text-[var(--muted)]" data-testid="bas-stations-note">
          The lines come from {new Set(plotted.map((p) => p.stationId)).size} JACEs, and each is stamped by its own
          station&apos;s clock - a station whose clock is off moves its line by that much.
        </p>
      )}
      <ViaParentStationNote stations={data.stations} selectedStationId={data.selectedStationId} />

      {/* -------------------------------------------------------- points */}

      <section className="card overflow-hidden" aria-label="Points" data-testid="bas-point-picker">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3">
          <h2 className="eyebrow text-[var(--muted)]">Point</h2>
          {selectedPoint === null ? (
            <span className="text-sm text-[var(--muted)]">
              {data.points.length === 0 ? "No points" : "Choose a point"}
            </span>
          ) : (
            <span className="inline-flex min-w-0 items-center gap-2 text-sm">
              <span className="truncate font-medium" data-testid="bas-selected-point">{selectedPoint.pointName}</span>
              <span className="text-xs text-[var(--muted)]">{selectedPoint.pointRole ?? "role not set"}</span>
              {lineCount > 1 && (
                <span className="text-xs text-[var(--muted)]">
                  + {lineCount - 1} more line{lineCount === 2 ? "" : "s"}
                </span>
              )}
            </span>
          )}
          {data.points.length > 0 && (
            <Button
              size="sm"
              className="ml-auto"
              onClick={() => setListOpen(!open)}
              ariaExpanded={open}
              testId="bas-point-list-toggle"
            >
              {open ? "Hide list" : selectedPoint === null ? "Show list" : "Choose another point"}
            </Button>
          )}
        </header>
        {open && data.points.length > 0 && (
          <PointList
            points={data.points}
            equipment={chosenEquipment}
            plotted={plotted}
            slotOf={slotOf}
            hotkey
            onPick={(id) => {
              // One point: opens it, as the dropdown did - the other lines go.
              setListOpen(false);
              setCascade(POINT_PARAM, id);
            }}
            onPlot={(ids) => {
              setListOpen(false);
              setLines(ids);
            }}
          />
        )}
      </section>

      {selectedPoint === null ? (
        data.points.length > 0 ? (
          // Nothing loaded, by request: a Projects card lands here. Points
          // exist and the person picks one; nothing is drawn until they do.
          <section
            className="card p-8 text-center"
            data-testid="bas-choose-point"
          >
            <p className="text-sm font-medium">Choose a point</p>
            <p className="mt-1 text-sm text-[var(--muted)]">
              {data.points.length === 1 ? "1 point" : `${data.points.length} points`}
              {data.scope.label === null ? "" : ` in ${data.scope.label}`}
            </p>
          </section>
        ) : (
          <section className="card p-8 text-center">
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

          {/*
            One block with the tiles, so the note sits on them: space-y sets
            margin-block-end on every child in Tailwind v4, and a negative
            margin on the note itself pulled the tiles up over it.
          */}
          <div className="space-y-2">
          {lineCount > 1 && (
            <p className="flex items-center gap-1.5 text-xs text-[var(--muted)]" data-testid="bas-showing-note">
              <LineSwatch slot={0} /> The tiles are showing {selectedPoint.pointName}, the first line on the chart.
            </p>
          )}
          <section
            aria-label="Point summary"
            className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
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
            {/*
              Data health (2026-11-20), in place of "Readings / null records"
              and "Distinct values": the expected interval and where it came
              from, the share of the period missing, the station's history
              with "assumed" or "measured" beside an assumed or measured
              number, and the stuck-sensor and physical-range warnings in the
              stuck-sensor colour. Null records stay, as a line.
            */}
            <DataHealthTile data={data} />
          </section>
          </div>

          {/* -------------------------------------------- trend summary */}

          <TrendSummaryCard data={data} lines={lineCount} />

          {/* ---------------------------------------------------- trend */}

          <TrendPanel
            data={data}
            unit={unit}
            view={view}
            onViewChange={(next) => setParam(VIEW_PARAM, next === "table" ? TABLE_VIEW : null)}
            slots={slots}
            onAdd={(id) => setLines(addSlot(slots, id))}
            onRemove={(id) => setLines(removeSlot(slots, id))}
          />

          {/* ----------------------------------------------------- gaps */}

          <GapTable
            gaps={data.dataGaps}
            pointName={selectedPoint.pointName}
            showing={lineCount > 1}
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
      <p className="eyebrow text-[var(--muted)]">
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
          <h2 className="eyebrow text-[var(--muted)]">
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

/** Chart or table: the kit's segmented strip, announcing itself as the toggle group it always was. */
function ViewToggle({ view, onChange }: { view: TrendView; onChange: (view: TrendView) => void }) {
  return (
    <Segmented
      semantics="pressed"
      tone="light"
      label="Show as"
      options={[
        { value: "chart", label: "Chart" },
        { value: "table", label: "Table" },
      ]}
      value={view}
      onChange={onChange}
    />
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
  slots,
  onAdd,
  onRemove,
}: {
  data: PointExplorerData;
  unit: string | null;
  /** Chart (default) or the raw readings behind it. */
  view?: TrendView;
  onViewChange?: (view: TrendView) => void;
  /** The chart's lines as slots (chart-lines.ts); absent, each line takes its position. */
  slots?: LineSlots;
  /** "Add point": a point id to draw as another line. Absent, no button. */
  onAdd?: (pointId: string) => void;
  /** The legend's remove button. */
  onRemove?: (pointId: string) => void;
}) {
  const plotted: PointOption[] =
    data.selectedPoint === null ? [] : [data.selectedPoint, ...data.comparisons.map((c) => c.point)];
  const several = plotted.length > 1;
  const slotFor = (pointId: string, position: number): number => {
    const at = slots?.indexOf(pointId) ?? -1;
    return at === -1 ? position : at;
  };
  const showingName = several && data.selectedPoint !== null ? data.selectedPoint.pointName : null;
  /**
   * The count, the longest and the share missing are invisible from the
   * chart; that the line stops at a break is not. The definition of a break
   * is interval.ts's, and the same sentence heads the list under the chart.
   * With several lines they are the first line's, and the heading says so.
   */
  const gapSummary =
    data.breaks.count === 0
      ? undefined
      : `${describeBreaks(data.breaks, data.expectedInterval)}${showingName === null ? "" : ` · showing ${showingName}`}`;
  const [adding, setAdding] = useState(false);

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
      // Every line on the chart: with more than one, the file is a column
      // per point aligned on timestamp (lib/modules/bas/csv.ts).
      const download = await downloadPointReadingsCsv({
        pointId: data.selectedPoint.pointId,
        from: data.range.from,
        to: data.range.to,
        compareIds: data.comparisons.map((c) => c.point.pointId),
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
        {/* Add point (2026-11-20): another line from anywhere; the URL carries the set. */}
        {view === "chart" && onAdd !== undefined && (
          <Button
            size="sm"
            onClick={() => setAdding((open) => !open)}
            ariaExpanded={adding}
            disabled={plotted.length >= MAX_CHART_LINES && !adding}
            title={plotted.length >= MAX_CHART_LINES ? `The chart holds ${MAX_CHART_LINES} lines. Remove one from the legend to add another.` : undefined}
            testId="bas-add-point-button"
          >
            Add point
          </Button>
        )}
        <ViewToggle view={view} onChange={(next) => onViewChange?.(next)} />
        <Button size="sm" onClick={() => void downloadCsv()} disabled={downloading} testId="bas-download-csv">
          {downloading ? "Downloading…" : "Download CSV"}
        </Button>
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
    data.expectedInterval.breakThresholdS * 1000,
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
      {adding && onAdd !== undefined && view === "chart" && (
        <AddPointPanel
          start={data}
          windowDays={data.windowDays}
          lines={plotted}
          onAdd={(id) => {
            setAdding(false);
            onAdd(id);
          }}
          onClose={() => setAdding(false)}
        />
      )}
      {view === "chart" &&
        data.comparisonNotes.map((note) => (
          <p key={note} className="border-b px-4 py-2 text-xs" style={noticeStyle} role="note" data-testid="bas-compare-note">
            {note}
          </p>
        ))}
      {view === "table" && showingName !== null && (
        <p className="border-b px-4 py-2 text-xs text-[var(--muted)]" data-testid="bas-table-showing">
          The table is showing {showingName}, the first line. Download CSV has every line, a column each.
        </p>
      )}
      {view === "table" && data.selectedPoint !== null ? (
        <ReadingsTable
          point={data.selectedPoint}
          range={data.range}
          extent={data.pointExtent}
          onTotal={(total) => setTableTotal({ key: tableKey, total })}
        />
      ) : data.trend.length === 0 && data.comparisons.every((c) => c.trend.length === 0) ? (
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
              {showingName === null ? "" : `${showingName}: `}
              {samplingNotice}
              {several && data.sampling.kind === "bucketed" &&
                ` With ${plotted.length} lines on the chart, each is drawn reading by reading up to ${formatCount(data.sampling.maxRaw)} readings and averaged past that.`}
            </p>
          )}
          {data.trend.length === 0 && data.selectedPoint !== null && (
            <p className="border-b px-4 py-2 text-xs" style={noticeStyle} role="note" data-testid="bas-no-readings">
              {describeNoReadings(data.selectedPoint.pointName, data.range, data.pointExtent)}
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
              <Button size="sm" onClick={() => setZoom(null)}>
                Reset zoom
              </Button>
            </div>
          )}

          {several && data.selectedPoint !== null && (
            <LinesLegend
              lines={[
                { point: data.selectedPoint, slot: 0, axis: "left", sampling: data.sampling },
                ...data.comparisons.map(
                  (c, i): LegendLine => ({ point: c.point, slot: slotFor(c.point.pointId, i + 1), axis: c.axis, sampling: c.sampling }),
                ),
              ]}
              onRemove={onRemove}
            />
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
                primaryName={data.selectedPoint?.pointName ?? ""}
                primaryWithinMs={data.expectedInterval.breakThresholdS * 1000}
                others={data.comparisons.map((c, i) => ({
                  pointId: c.point.pointId,
                  trend: c.trend,
                  unit: c.point.unit,
                  states: c.point.states,
                  name: c.point.pointName,
                  axis: c.axis,
                  slot: slotFor(c.point.pointId, i + 1),
                  withinMs: breakThresholdS(c.expectedInterval.seconds) * 1000,
                }))}
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
            The breaks, written down: the summary line, the five longest with
            both timestamps and a duration - the form that survives being read
            out over the phone - and the rest behind "Show all" (2026-11-20).
            One line per break was 280 lines a week on a point nobody had
            entered an interval for. The recorded gaps get no sentence here -
            their outline on the chart carries the cause, and the table below
            lists them.
          */}
          <BreaksList breaks={data.breaks} expected={data.expectedInterval} timeZone={timeZone} showing={showingName} />
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
  others = [],
  primaryName = "",
  primaryWithinMs = Number.POSITIVE_INFINITY,
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
  /**
   * The chart's other lines (2026-11-20): each over the same range, on the
   * left axis when it is the first line's quantity and on the right axis
   * otherwise. Their samples keep their own timestamps and their own breaks;
   * the shared cursor reads each line's value at it from them.
   */
  others?: ChartLine[];
  /** The first line's name, for the shared cursor's readout. */
  primaryName?: string;
  /** How far from the cursor the first line's sample may be and still be "its value then". */
  primaryWithinMs?: number;
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
  const inView = (point: { tsMs: number }) =>
    zoom === null || (point.tsMs >= zoom.from && point.tsMs <= zoom.to);
  const valuesOf = (line: ChartLine) =>
    line.trend
      .filter(inView)
      .map((point) => point.value)
      .filter((value): value is number => value !== null);
  const leftOthers = others.filter((line) => line.axis === "left");
  const rightLines = others.filter((line) => line.axis === "right");
  const visibleValues = trend
    .filter(inView)
    .flatMap((point) => [point.value, point.min ?? null, point.max ?? null])
    .filter((value): value is number => value !== null)
    // Every line on the left axis is the first line's quantity: all must fit on it.
    .concat(leftOthers.flatMap(valuesOf));
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
  // The right axis: the second quantity, labelled by the first line drawn on
  // it, fitted to every line on it.
  const rightOwner = rightLines[0] ?? null;
  const rightAxis =
    rightOwner === null
      ? null
      : rightOwner.states !== null
        ? stateAxis(rightOwner.states, { fontSize: CHART_FONT_SIZE })
        : valueAxis(rightLines.flatMap(valuesOf), rightOwner.unit, { fontSize: CHART_FONT_SIZE });
  // What the cursor walks: the first line's samples, or - when it has none in
  // the range - the busiest other line's, so the readout still works.
  const track =
    trend.length > 0 || others.length === 0
      ? trend
      : others.reduce((a, b) => (b.trend.length > a.trend.length ? b : a)).trend;

  return (
    <AreaChart
      data={track}
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
      {rightOwner !== null && rightAxis !== null && (
        <YAxis
          yAxisId="right"
          orientation="right"
          stroke="var(--muted)"
          tick={{ fontSize: CHART_FONT_SIZE }}
          width={rightAxis.width}
          domain={rightAxis.domain}
          ticks={rightAxis.ticks}
          interval={0}
          tickFormatter={(value: number) =>
            rightOwner.states !== null
              ? formatStateTick(value, rightOwner.states)
              : formatAxisTick(value, rightAxis.decimals)
          }
          label={
            rightOwner.states !== null
              ? undefined
              : {
                  value: axisLabel(rightOwner.unit),
                  angle: 90,
                  position: "insideRight",
                  style: { fontSize: CHART_FONT_SIZE, fill: "var(--muted)" },
                }
          }
        />
      )}
      {others.length > 0 ? (
        <Tooltip
          defaultIndex={tooltipIndex}
          content={(props: { active?: boolean; label?: unknown }) => (
            <LinesTooltip
              active={props.active === true}
              label={typeof props.label === "number" ? props.label : null}
              lines={[
                { trend, unit, states, name: primaryName, slot: 0, withinMs: primaryWithinMs },
                ...others,
              ]}
              zone={zone}
            />
          )}
        />
      ) : (
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
      )}
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
          data={trend}
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
        data={trend}
        type={lineType}
        dataKey="value"
        name="value"
        // One accent, and it is the module's: the first line is slot 0.
        stroke={lineStyle(0).stroke}
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
      {/*
        The other lines: each in its slot's colour and dash, no fill, on its
        own data so its timestamps and its breaks are its own - an explicit
        null breaks it exactly as it breaks the first line.
      */}
      {others.map((line) => (
        <Area
          key={line.pointId}
          data={line.trend}
          yAxisId={line.axis === "left" ? 0 : "right"}
          type={line.states !== null ? "stepAfter" : "monotone"}
          dataKey="value"
          name={`line-${line.slot}`}
          stroke={lineStyle(line.slot).stroke}
          strokeDasharray={lineStyle(line.slot).dash}
          strokeWidth={1.75}
          fill="none"
          fillOpacity={0}
          dot={false}
          activeDot={false}
          connectNulls={false}
          isAnimationActive={false}
        />
      ))}
    </AreaChart>
  );
}

/** One of the chart's other lines, as TrendChart draws it. */
export interface ChartLine {
  pointId: string;
  trend: PointExplorerData["trend"];
  unit: string | null;
  states: BooleanStates | null;
  name: string;
  axis: AxisSide;
  /** Its colour and dash (chart-lines.ts LINE_STYLES). */
  slot: number;
  /** How far from the cursor its sample may be and still be "its value then". */
  withinMs: number;
}

/**
 * The shared cursor's readout with several lines: one time, every line's value
 * at it, each in its own unit or state words, each beside its swatch. A
 * line's value is its nearest sample within its own break rule - never one
 * from the far side of a hole. Exported for tests.
 */
export function LinesTooltip({
  active,
  label,
  lines,
  zone,
}: {
  active: boolean;
  label: number | null;
  lines: ReadonlyArray<Pick<ChartLine, "trend" | "unit" | "states" | "name" | "slot" | "withinMs">>;
  zone: string | undefined;
}) {
  if (!active || label === null) return null;
  const word = (value: number | null, u: string | null, s: BooleanStates | null) =>
    value === null ? "no reading" : s !== null ? formatStateTooltip(value, s) : formatTooltipValue(value, u);
  return (
    <div
      className="rounded-[0.625rem] border border-[var(--border)] bg-white px-3 py-2 text-xs shadow-sm"
      data-testid="bas-lines-tooltip"
    >
      <p className="font-medium">{formatTimestamp(new Date(label).toISOString(), undefined, zone)}</p>
      {lines.map((line) => (
        <p key={`${line.slot}-${line.name}`} className="flex items-center gap-1.5">
          <LineSwatch slot={line.slot} />
          <span>
            {line.name}: {word(comparisonValueAt(line.trend, label, line.withinMs), line.unit, line.states)}
          </span>
        </p>
      ))}
    </div>
  );
}

function GapTable({
  gaps,
  pointName,
  showing = false,
}: {
  gaps: DataGapRow[];
  pointName: string;
  /** Several lines on the chart: the title names the point these gaps are of. */
  showing?: boolean;
}) {
  const overwritten = gaps.filter((gap) => gap.cause === "roll_overwrite");

  return (
    <Panel
      title={showing ? `Known data gaps for ${pointName} — periods we did not collect` : "Known data gaps — periods we did not collect"}
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
            <table className="w-full min-w-[42rem] border-collapse text-[0.8125rem]">
              <thead className="sticky top-0 z-10 bg-[var(--surface)] text-left">
                <tr>
                  <th className="eyebrow px-3 py-2.5 text-[var(--muted)]">From</th>
                  <th className="eyebrow px-3 py-2.5 text-[var(--muted)]">To</th>
                  <th className="eyebrow px-3 py-2.5 text-right text-[var(--muted)]">Hours lost</th>
                  <th className="eyebrow px-3 py-2.5 text-[var(--muted)]">Cause</th>
                  <th className="eyebrow px-3 py-2.5 text-[var(--muted)]">Notes</th>
                </tr>
              </thead>
              <tbody>
                {gaps.map((gap) => (
                  <tr key={gap.gapId} className="border-t border-[var(--divider-soft)]">
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
                          "inline-block rounded-full border px-2 py-0.5 text-[0.6875rem] font-medium " +
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
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div
            key={i}
            className="card p-4"
          >
            <div className="h-2.5 w-2/3 animate-pulse rounded bg-[var(--border)]" />
            <div className="mt-3 h-6 w-1/3 animate-pulse rounded bg-[var(--border)]" />
          </div>
        ))}
      </div>
      <div className="card overflow-hidden">
        <div className="h-10 border-b border-[var(--border)] bg-[var(--surface)]" />
        <div className="h-72 animate-pulse bg-[var(--surface)]" />
      </div>
    </div>
  );
}


/**
 * When the chosen JACE is a via-parent station (2026-11-20): that it is read
 * through its parent, and ITS OWN last pass - the parent's pass being ok says
 * nothing about whether this station's folder was there. Nothing for a direct
 * station or no selection. Exported for tests.
 */
export function ViaParentStationNote({
  stations,
  selectedStationId,
}: {
  stations: ReadonlyArray<{
    stationId: string;
    name: string;
    viaParent: boolean;
    parentName: string | null;
    lastPass: { status: string; at: string } | null;
  }>;
  selectedStationId: string | null;
}) {
  const station = stations.find((row) => row.stationId === selectedStationId);
  if (station === undefined || !station.viaParent) return null;
  const pass = describeStationPass(station.lastPass);
  return (
    <p className="-mt-4 text-xs text-[var(--muted)]" data-testid="bas-via-parent-note">
      {station.name} is collected through {station.parentName ?? "its parent station"}
      {" · "}
      <span style={{ color: pass.tone === "ok" ? undefined : TONE_INK[pass.tone] }}>{pass.label}</span>
    </p>
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
  options: DropdownOption[];
  onChange: (value: string | null) => void;
}) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-[var(--muted)]">{label}</span>
      <Dropdown
        label={label}
        value={value ?? ALL_SITES}
        onChange={(next) => onChange(next === ALL_SITES ? null : next)}
        disabled={options.length === 0}
        options={[
          { value: ALL_SITES, label: "All" },
          ...options,
        ]}
        className="min-w-44"
      />
    </div>
  );
}
