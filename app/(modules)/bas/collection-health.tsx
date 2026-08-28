"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type {
  CollectionHealth as CollectionHealthData,
  DataGapRow,
  IngestRunRow,
  PointHealthRow,
  RollRisk,
} from "@/lib/modules/bas/types";
import {
  ApiError,
  RISK_EXPLANATION,
  RISK_LABEL,
  WINDOW_PRESETS,
  activePointsTone,
  atRiskTone,
  basRiskTone,
  describeEmptyRuns,
  describeRunGap,
  describeScope,
  fetchCollectionHealth,
  formatChartTick,
  formatCount,
  formatHours,
  formatMinutes,
  formatTimestamp,
  riskBreakdown,
  runGapTone,
  stalenessTone,
  totalReadingsTone,
  unclassifiedTone,
  atRiskShape,
  describeAtRisk,
  windowLabel,
  type Tone,
} from "./health-client";
import { ALL_SITES, DAYS_PARAM, SITE_PARAM, readFilters, withFilter } from "./filters";

/**
 * Collection Health - is data arriving, and is any of it about to be lost.
 *
 * The Grafana dashboard at dashboards/bas-collection-health.json is the oracle
 * for every number here; this screen is that dashboard, panel for panel, inside
 * the platform. Where they disagree, this screen is wrong.
 *
 * The thing it must never do is look calm. A building controller keeps roughly
 * two days of history and then overwrites silently - no alarm, no log entry, no
 * gap marker - so a screen that renders an unknown as green, or an outage as
 * simply fewer rows, is worse than no screen at all. That is why the risk tile
 * carries its own breakdown, why the run chart is plotted on a real time axis
 * rather than by run number, and why a collector silence longer than the roll
 * horizon gets a sentence rather than a shape.
 */

/**
 * A minute is the resolution of everything on this screen and the collector
 * polls every fifteen, so anything faster is churn. Same visibility rules as the
 * mailbox: a background tab polls nobody's database.
 */
const POLL_INTERVAL_MS = 60_000;



/**
 * The semantic palette, from the sampled logo colours.
 *
 * Semantic colour is separate from the module accent and always has been: the
 * module's cyan says "you are in Building Automation" and never appears on a
 * tile, so a healthy teal tile cannot be mistaken for a module-coloured one.
 * Cyan is reserved for the header diamond, the active tab and the trend line.
 *
 * The mapping, and every value clears WCAG AA as text on its own tint - see the
 * ink tier in app/globals.css:
 *
 *   ok       teal      the "SINCE" lettering
 *   warn     orange    the lower-left quadrant
 *   bad      maroon    the lower tip
 *   neutral  greys     "we have no answer", which is not a colour
 */
const tint = (token: string, percent: number) =>
  `color-mix(in srgb, var(${token}) ${percent}%, transparent)`;

const TONE_STYLE: Record<Tone, React.CSSProperties> = {
  ok: { borderColor: tint("--phb-teal", 55), background: tint("--phb-teal", 12) },
  warn: {
    borderColor: tint("--phb-orange", 55),
    background: tint("--phb-orange", 12),
  },
  bad: {
    borderColor: tint("--phb-maroon", 40),
    background: tint("--phb-maroon", 8),
  },
  neutral: { borderColor: "var(--border)", background: "var(--surface)" },
};

const TONE_INK: Record<Tone, string> = {
  ok: "var(--phb-teal-ink)",
  warn: "var(--phb-orange-ink)",
  bad: "var(--phb-maroon)",
  neutral: "var(--foreground)",
};

const RUN_STATUS_TONE: Record<IngestRunRow["status"], Tone> = {
  ok: "ok",
  running: "neutral",
  partial: "warn",
  failed: "bad",
};

/**
 * `roll_overwrite` is the unrecoverable cause: the station destroyed the data
 * before we reached it. The others mean we did not collect, which is recoverable
 * in principle and a different conversation.
 */
const GAP_CAUSE_LABEL: Record<string, string> = {
  roll_overwrite: "Station overwrote it",
  collector_down: "Collector was down",
  station_unreachable: "Station unreachable",
  point_added_later: "Point added later",
  station_clock_change: "Station clock changed",
  unknown: "Unknown",
};

export function CollectionHealth() {
  const [health, setHealth] = useState<CollectionHealthData | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);

  // The two controls live in the URL, not in React state, so they survive a tab
  // switch, a refresh and a bookmark. See filters.ts. The filtering itself still
  // happens in SQL - see lib/modules/bas/service.ts, `siteFilter`.
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { siteId, windowDays } = readFilters(searchParams);

  const setParam = (key: string, value: string | null) => {
    router.replace(`${pathname}${withFilter(searchParams, key, value)}`, {
      scroll: false,
    });
  };

  const load = useCallback(
    async (
      selection: { days: number; siteId: string | null },
      options: { quiet?: boolean } = {},
    ) => {
      if (options.quiet !== true) setLoading(true);
      try {
        const data = await fetchCollectionHealth({
          days: selection.days,
          siteId: selection.siteId,
        });
        setHealth(data);
        setError(null);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") {
          return;
        }
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
    void load({ days: windowDays, siteId });
  }, [load, windowDays, siteId]);

  /**
   * A selected building that has stopped being visible - removed, or a site
   * grant revoked while the tab was open - would otherwise leave the screen
   * stuck on an error it cannot clear from its own controls. Dropping the
   * parameter puts it back on "All", and the effect above refetches.
   *
   * Kept out of `load` deliberately: doing it there would make the fetch
   * callback depend on the router and the current query string, so every filter
   * change would rebuild it and fire a second request.
   */
  useEffect(() => {
    if (error?.code === "not_found" && siteId !== null) {
      router.replace(`${pathname}${withFilter(searchParams, SITE_PARAM, null)}`, {
        scroll: false,
      });
    }
  }, [error, siteId, router, pathname, searchParams]);

  // Same shape as the mailbox workspace: poll only while the tab is visible,
  // catch up on return, and never leave a timer behind.
  //
  // The ref carries the CURRENT selection, not the one that was current when the
  // timer was installed. Without it the poll would quietly revert the screen to
  // seven days and all buildings a minute after someone changed either control.
  const pollRef = useRef<() => void>(() => {});
  pollRef.current = () => {
    void load({ days: windowDays, siteId }, { quiet: true });
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

  if (loading && health === null) return <HealthSkeleton />;

  if (error !== null && health === null) {
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
          onClick={() => void load({ days: windowDays, siteId })}
          className="mt-4 rounded border border-red-300 bg-white px-3 py-1.5 text-sm hover:bg-red-100"
        >
          Try again
        </button>
      </section>
    );
  }

  if (health === null) return <HealthSkeleton />;

  const { totals } = health;
  const gapSentence = describeRunGap(health.longestRunGap);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-[var(--muted)]">Building</span>
            <select
              value={health.selectedSiteId ?? ALL_SITES}
              onChange={(event) => setParam(SITE_PARAM, event.target.value)}
              disabled={health.sites.length === 0}
              className="rounded border border-[var(--border)] bg-white px-2 py-1 text-sm disabled:opacity-50"
            >
              <option value={ALL_SITES}>All</option>
              {health.sites.map((site) => (
                <option key={site.siteId} value={site.siteId}>
                  {site.name}
                </option>
              ))}
            </select>
          </label>

          <div
            className="flex items-center gap-2 text-sm"
            role="group"
            aria-label="Run history range"
          >
            <span className="text-[var(--muted)]">Range</span>
            <div className="flex overflow-hidden rounded border border-[var(--border)]">
              {WINDOW_PRESETS.map((preset) => (
                <button
                  key={preset.days}
                  type="button"
                  aria-pressed={health.windowDays === preset.days}
                  onClick={() => setParam(DAYS_PARAM, String(preset.days))}
                  className={
                    "border-l border-[var(--border)] px-2.5 py-1 text-sm first:border-l-0 " +
                    (health.windowDays === preset.days
                      ? "bg-[var(--accent)] text-white"
                      : "bg-white hover:bg-[var(--surface)]")
                  }
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {error !== null && (
          <p className="text-xs text-red-700" role="alert">
            The last refresh failed. Showing the previous reading.
          </p>
        )}
      </div>

      {/*
        The selection restated in words, next to the data rather than only in the
        controls that set it. Two controls change what every panel means, and a
        reader who has lost track of which building is selected cannot tell a
        real zero from a filtered one.
      */}
      <p className="-mt-3 text-xs text-[var(--muted)]">
        {describeScope(health.selectedSiteName, health.windowDays)} · as of{" "}
        {formatTimestamp(health.observedAt)} · refreshes every minute while this
        tab is open
      </p>

      {/* ------------------------------------------------------- five tiles */}

      <section
        aria-label="Collection summary"
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5"
      >
        <Tile
          label="Active points"
          value={formatCount(totals.activePoints)}
          tone={activePointsTone()}
          detail={
            totals.activePoints === 0
              ? "No points have been discovered yet."
              : undefined
          }
        />

        <Tile
          label="Total readings"
          value={formatCount(totals.totalReadings)}
          tone={totalReadingsTone()}
          detail={
            totals.totalReadings === 0
              ? "Nothing has been collected into this database."
              : undefined
          }
        />

        <Tile
          label="Unclassified points"
          value={formatCount(totals.unclassifiedPoints)}
          tone={unclassifiedTone(totals.unclassifiedPoints)}
          detail={
            totals.unclassifiedPoints === 0
              ? "Every active point has a role."
              : "No point_role, so invisible to every question phrased by what a point measures. A backlog, not a fault."
          }
        />

        {/*
          The one tile with two different problems behind a single count, so it
          is the one tile that says which. "3 points, capacity unknown" and
          "3 points losing data" call for different actions - fill in Workbench,
          or find out why the collector stopped - and nobody should have to read
          a stripe to tell them apart.

          The stripe is the second signal rather than the only one, and it is
          what keeps this distinguishable from the unclassified tile when both
          are amber.
        */}
        <Tile
          label="Points at risk of data loss"
          value={formatCount(totals.pointsAtRisk)}
          tone={atRiskTone(totals.riskCounts)}
          headline={
            totals.pointsAtRisk > 0 ? describeAtRisk(totals.riskCounts) : undefined
          }
          stripe={totals.pointsAtRisk > 0}
          detail={
            totals.pointsAtRisk === 0
              ? "Every active point was collected inside half its roll horizon."
              : atRiskShape(totals.riskCounts) === "unknown"
                ? "Nothing is lost yet. The roll horizon cannot be computed for these, so we cannot tell whether records are being overwritten."
                : "The station has overwritten records that were never collected. Those are gone permanently."
          }
        >
          {totals.pointsAtRisk > 0 && (
            <ul className="mt-2 space-y-0.5 text-xs">
              {riskBreakdown(totals.riskCounts).map(({ risk, count }) => (
                <li key={risk} title={RISK_EXPLANATION[risk]}>
                  {formatCount(count)} {RISK_LABEL[risk].toLowerCase()}
                </li>
              ))}
            </ul>
          )}
        </Tile>

        <Tile
          label="Since newest reading"
          value={formatMinutes(totals.minutesSinceNewestReading)}
          tone={stalenessTone(totals.minutesSinceNewestReading)}
          detail={
            totals.minutesSinceNewestReading === null
              ? "There are no readings at all. This is not a healthy zero."
              : "Well past the poll interval means the collector has stopped."
          }
        />
      </section>

      {/* -------------------------------------------------- collector silence */}

      {gapSentence !== null && (
        <section
          className="rounded border p-4 text-sm"
          style={{
            ...TONE_STYLE[runGapTone(health.longestRunGap)],
            color: TONE_INK[runGapTone(health.longestRunGap)],
          }}
        >
          <p className="font-medium">Longest collector silence</p>
          <p className="mt-1">{gapSentence}</p>
          {health.longestRunGap !== null && (
            <p className="mt-1 text-xs opacity-80">
              {formatTimestamp(health.longestRunGap.fromAt)} →{" "}
              {formatTimestamp(health.longestRunGap.toAt)}
            </p>
          )}
        </section>
      )}

      {/* --------------------------------------------------- per-point table */}

      <PointTable points={health.points} siteName={health.selectedSiteName} />

      {/* ------------------------------------------- runs: chart and history */}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <RunChart health={health} />
        <RunTable health={health} />
      </div>

      {/* ------------------------------------------------------ recorded gaps */}

      <DataGapTable gaps={health.dataGaps} siteName={health.selectedSiteName} />
    </div>
  );
}

// ------------------------------------------------------------------ pieces

function Tile({
  label,
  value,
  tone,
  detail,
  headline,
  stripe = false,
  children,
}: {
  label: string;
  value: string;
  tone: Tone;
  detail?: string;
  /**
   * A sentence under the number saying WHICH problem this is.
   *
   * Only the at-risk tile has two different problems behind one count, and it is
   * the one place where the number alone is the least useful part of the answer.
   */
  headline?: string;
  /**
   * A severity bar down the left edge.
   *
   * Carried only by the tile that reports possible data loss. It is what keeps
   * "we might be losing data" distinguishable from "this is less useful than it
   * could be" when both are amber - the brief requires those two to stay
   * visually distinct, and hue alone cannot do it once they share one.
   */
  stripe?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={"relative overflow-hidden rounded border p-4 " + (stripe ? "pl-5" : "")}
      style={TONE_STYLE[tone]}
    >
      {stripe && (
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-0 w-1"
          style={{ background: TONE_INK[tone] }}
        />
      )}
      <p className="text-[0.6875rem] font-medium uppercase tracking-[0.08em] text-[var(--muted)]">
        {label}
      </p>
      <p
        className="mt-1 text-2xl font-semibold tabular-nums"
        style={{ color: TONE_INK[tone] }}
      >
        {value}
      </p>
      {headline !== undefined && (
        <p className="mt-0.5 text-[0.8125rem] font-medium" style={{ color: TONE_INK[tone] }}>
          {headline}
        </p>
      )}
      {children}
      {detail !== undefined && (
        <p className="mt-2 text-xs leading-relaxed text-[var(--muted)]">{detail}</p>
      )}
    </div>
  );
}

function RiskBadge({ risk }: { risk: RollRisk }) {
  return (
    <span
      title={RISK_EXPLANATION[risk]}
      className="inline-block rounded-[2px] border px-1.5 py-0.5 text-[0.6875rem] font-medium"
      style={{
        ...TONE_STYLE[basRiskTone(risk)],
        color: TONE_INK[basRiskTone(risk)],
      }}
    >
      {RISK_LABEL[risk]}
    </span>
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
    <section className="rounded border border-[var(--border)]">
      <header className="border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2.5">
        <h2 className="text-sm font-medium">{title}</h2>
        {description !== undefined && (
          <p className="mt-0.5 text-xs text-[var(--muted)]">{description}</p>
        )}
      </header>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-4 py-8 text-center text-sm text-[var(--muted)]">
      {children}
    </p>
  );
}

function Th({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      className={
        "px-3 py-2 font-medium " + (align === "right" ? "text-right" : "")
      }
    >
      {children}
    </th>
  );
}

function PointTable({
  points,
  siteName,
}: {
  points: PointHealthRow[];
  siteName: string | null;
}) {
  return (
    <Panel
      title="Per-point collection status"
      description="Active points, stalest first. A point that has never been collected sorts above one that is merely late."
    >
      {points.length === 0 ? (
        <Empty>
          {siteName === null
            ? "No active points. Nothing has been discovered on the station yet, or every point has been marked inactive."
            : `No active points at ${siteName}. Another building may still have some — switch the filter to All.`}
        </Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[52rem] border-collapse text-sm">
            <thead className="bg-[var(--surface)] text-left">
              <tr>
                <Th>Point</Th>
                <Th>Site</Th>
                <Th>Role</Th>
                <Th>Unit</Th>
                <Th>Risk</Th>
                <Th>Last reading</Th>
                <Th align="right">Minutes ago</Th>
                <Th align="right">Roll horizon</Th>
              </tr>
            </thead>
            <tbody>
              {points.map((point) => (
                <tr
                  key={point.pointId}
                  className="border-t border-[var(--border)]"
                >
                  <td className="px-3 py-2 font-medium">{point.pointName}</td>
                  <td className="px-3 py-2 text-[var(--muted)]">
                    {point.siteName}
                  </td>
                  <td className="px-3 py-2">
                    {point.pointRole ?? (
                      <span className="text-amber-800" title="No point_role.">
                        unclassified
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-[var(--muted)]">
                    {point.unit ?? "—"}
                  </td>
                  <td className="px-3 py-2">
                    <RiskBadge risk={point.risk} />
                  </td>
                  <td className="px-3 py-2 text-[var(--muted)]">
                    {formatTimestamp(point.lastReadingAt)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {point.minutesAgo === null
                      ? "—"
                      : formatCount(point.minutesAgo)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {point.rollHorizonHours === null ? (
                      <span
                        className="text-amber-800"
                        title={RISK_EXPLANATION.roll_horizon_unknown}
                      >
                        unknown
                      </span>
                    ) : (
                      formatHours(point.rollHorizonHours)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function RunChart({ health }: { health: CollectionHealthData }) {
  return (
    <Panel
      title="Records written per collector run"
      description="Plotted on real time, not by run number - so a period when the collector did not run is a hole rather than nothing. A spike is a backfill catching up after an outage."
    >
      {health.runRecords.length === 0 ? (
        <Empty>
          {describeEmptyRuns(
            health.newestRunAt,
            health.windowDays,
            health.selectedSiteName,
          )}
        </Empty>
      ) : (
        <div className="h-64 p-3">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={health.runRecords}
              margin={{ top: 8, right: 8, bottom: 4, left: 4 }}
            >
              <CartesianGrid stroke="var(--border)" vertical={false} />
              <XAxis
                dataKey="startedAtMs"
                // The whole point of the panel. A category axis would space the
                // runs evenly and erase a three-day outage.
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                tickFormatter={(ms: number) => formatChartTick(ms)}
                stroke="var(--muted)"
                tick={{ fontSize: 11 }}
                minTickGap={40}
              />
              <YAxis
                stroke="var(--muted)"
                tick={{ fontSize: 11 }}
                width={48}
                allowDecimals={false}
              />
              <Tooltip
                cursor={{ fill: "var(--surface)" }}
                // Recharts types these loosely (ReactNode / ValueType), so the
                // narrowing happens here rather than in the signature.
                labelFormatter={(ms) =>
                  typeof ms === "number"
                    ? formatTimestamp(new Date(ms).toISOString())
                    : ""
                }
                formatter={(value) => [
                  typeof value === "number" ? formatCount(value) : String(value),
                  "records written",
                ]}
                contentStyle={{
                  fontSize: "0.75rem",
                  border: "1px solid var(--border)",
                  borderRadius: "0.25rem",
                }}
              />
              <Bar
                dataKey="recordsWritten"
                fill="var(--accent)"
                barSize={4}
                isAnimationActive={false}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </Panel>
  );
}

function RunTable({ health }: { health: CollectionHealthData }) {
  const runs = health.runs;

  return (
    <Panel
      title="Recent collector runs"
      description={`Inside the last ${windowLabel(health.windowDays)}, newest first, up to 30.`}
    >
      {runs.length === 0 ? (
        // Never "no runs" on its own. An empty list because the collector has
        // never run and an empty list because it last ran outside a 24-hour
        // window look identical and mean opposite things.
        <Empty>
          {describeEmptyRuns(
            health.newestRunAt,
            health.windowDays,
            health.selectedSiteName,
          )}
        </Empty>
      ) : (
        <div className="max-h-64 overflow-auto">
          <table className="w-full min-w-[34rem] border-collapse text-sm">
            <thead className="sticky top-0 bg-[var(--surface)] text-left">
              <tr>
                <Th>Started</Th>
                <Th>Status</Th>
                <Th align="right">Points</Th>
                <Th align="right">Records</Th>
                <Th>Host</Th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.runId} className="border-t border-[var(--border)]">
                  <td className="px-3 py-2 text-[var(--muted)]">
                    {formatTimestamp(run.startedAt)}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className="inline-block rounded-[2px] border px-1.5 py-0.5 text-[0.6875rem] font-medium"
                      style={{
                        ...TONE_STYLE[RUN_STATUS_TONE[run.status]],
                        color: TONE_INK[RUN_STATUS_TONE[run.status]],
                      }}
                    >
                      {run.status}
                    </span>
                    {run.errorCount > 0 && (
                      <span className="ml-2 text-xs text-red-700">
                        {formatCount(run.errorCount)} error
                        {run.errorCount === 1 ? "" : "s"}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatCount(run.pointsSucceeded)}/
                    {formatCount(run.pointsAttempted)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatCount(run.recordsWritten)}
                  </td>
                  <td className="px-3 py-2 text-[var(--muted)]">
                    {run.collectorHost ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function DataGapTable({
  gaps,
  siteName,
}: {
  gaps: DataGapRow[];
  siteName: string | null;
}) {
  const overwritten = gaps.filter((gap) => gap.cause === "roll_overwrite");

  return (
    <Panel
      title="Recorded data gaps — periods we did not collect"
      description="A gap means we were not watching. Before concluding equipment was off, check whether we were even reading."
    >
      {gaps.length === 0 ? (
        <Empty>
          {siteName === null
            ? "No gaps recorded."
            : `No gaps recorded at ${siteName}.`}
        </Empty>
      ) : (
        <>
          {overwritten.length > 0 && (
            <p className="border-b border-red-300 bg-red-50 px-4 py-2.5 text-sm text-red-900">
              {formatCount(overwritten.length)} of these
              {overwritten.length === 1 ? " is" : " are"} station overwrites:
              the data existed, the station destroyed it before we read it, and
              it cannot be recovered from anywhere. Each one means the poll
              cadence was wrong for that point.
            </p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] border-collapse text-sm">
              <thead className="bg-[var(--surface)] text-left">
                <tr>
                  <Th>Point</Th>
                  <Th>Site</Th>
                  <Th>From</Th>
                  <Th>To</Th>
                  <Th align="right">Hours lost</Th>
                  <Th>Cause</Th>
                </tr>
              </thead>
              <tbody>
                {gaps.map((gap) => (
                  <tr
                    key={gap.gapId}
                    className="border-t border-[var(--border)]"
                  >
                    <td className="px-3 py-2 font-medium">{gap.pointName}</td>
                    <td className="px-3 py-2 text-[var(--muted)]">
                      {gap.siteName}
                    </td>
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
                        className="inline-block rounded-[2px] border px-1.5 py-0.5 text-[0.6875rem] font-medium"
                        style={{
                          ...TONE_STYLE[gap.cause === "roll_overwrite" ? "bad" : "warn"],
                          color: TONE_INK[gap.cause === "roll_overwrite" ? "bad" : "warn"],
                        }}
                      >
                        {GAP_CAUSE_LABEL[gap.cause] ?? gap.cause}
                      </span>
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

/**
 * Skeletons rather than a spinner, for the same reason the mailbox uses them: a
 * spinner replaced by content moves the layout every refresh.
 */
function HealthSkeleton() {
  return (
    <div className="space-y-6" aria-hidden="true">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
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
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="border-t border-[var(--border)] px-3 py-3">
            <div className="h-3 w-1/2 animate-pulse rounded bg-[var(--border)]" />
          </div>
        ))}
      </div>
    </div>
  );
}
