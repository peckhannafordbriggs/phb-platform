"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  activePointsTone,
  atRiskTone,
  basRiskTone,
  describeRunGap,
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
  type Tone,
} from "./health-client";

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

const TONE_TILE: Record<Tone, string> = {
  ok: "border-emerald-300 bg-emerald-50",
  warn: "border-amber-300 bg-amber-50",
  bad: "border-red-300 bg-red-50",
  neutral: "border-[var(--border)] bg-[var(--surface)]",
};

const TONE_VALUE: Record<Tone, string> = {
  ok: "text-emerald-900",
  warn: "text-amber-900",
  bad: "text-red-900",
  neutral: "text-[var(--foreground)]",
};

const TONE_BADGE: Record<Tone, string> = {
  ok: "border-emerald-300 bg-emerald-50 text-emerald-900",
  warn: "border-amber-300 bg-amber-50 text-amber-900",
  bad: "border-red-300 bg-red-50 text-red-900",
  neutral: "border-[var(--border)] bg-[var(--surface)] text-[var(--muted)]",
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

  const load = useCallback(async (options: { quiet?: boolean } = {}) => {
    if (options.quiet !== true) setLoading(true);
    try {
      const data = await fetchCollectionHealth();
      setHealth(data);
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
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Same shape as the mailbox workspace: poll only while the tab is visible,
  // catch up on return, and never leave a timer behind.
  const loadRef = useRef(load);
  loadRef.current = load;

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
      timer = setInterval(
        () => void loadRef.current({ quiet: true }),
        POLL_INTERVAL_MS,
      );
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void loadRef.current({ quiet: true });
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
          onClick={() => void load()}
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
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs text-[var(--muted)]">
          As of {formatTimestamp(health.observedAt)} · refreshes every minute
          while this tab is open · run history covers the last{" "}
          {health.windowDays} days
        </p>
        {error !== null && (
          <p className="text-xs text-red-700" role="alert">
            The last refresh failed. Showing the previous reading.
          </p>
        )}
      </div>

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

        <Tile
          label="Points at risk of data loss"
          value={formatCount(totals.pointsAtRisk)}
          tone={atRiskTone(totals.pointsAtRisk)}
          detail={
            totals.pointsAtRisk === 0
              ? "Every active point was collected inside half its roll horizon."
              : undefined
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
          className={
            "rounded border p-4 text-sm " +
            TONE_TILE[runGapTone(health.longestRunGap)] +
            " " +
            TONE_VALUE[runGapTone(health.longestRunGap)]
          }
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

      <PointTable points={health.points} />

      {/* ------------------------------------------- runs: chart and history */}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <RunChart health={health} />
        <RunTable runs={health.runs} />
      </div>

      {/* ------------------------------------------------------ recorded gaps */}

      <DataGapTable gaps={health.dataGaps} />
    </div>
  );
}

// ------------------------------------------------------------------ pieces

function Tile({
  label,
  value,
  tone,
  detail,
  children,
}: {
  label: string;
  value: string;
  tone: Tone;
  detail?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={"rounded border p-4 " + TONE_TILE[tone]}>
      <p className="text-xs font-medium text-[var(--muted)]">{label}</p>
      <p className={"mt-1 text-2xl font-semibold " + TONE_VALUE[tone]}>
        {value}
      </p>
      {children}
      {detail !== undefined && (
        <p className="mt-2 text-xs text-[var(--muted)]">{detail}</p>
      )}
    </div>
  );
}

function RiskBadge({ risk }: { risk: RollRisk }) {
  return (
    <span
      title={RISK_EXPLANATION[risk]}
      className={
        "inline-block rounded border px-1.5 py-0.5 text-xs font-medium " +
        TONE_BADGE[basRiskTone(risk)]
      }
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

function PointTable({ points }: { points: PointHealthRow[] }) {
  return (
    <Panel
      title="Per-point collection status"
      description="Active points, stalest first. A point that has never been collected sorts above one that is merely late."
    >
      {points.length === 0 ? (
        <Empty>
          No active points. Nothing has been discovered on the station yet, or
          every point has been marked inactive.
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
          No collector runs in the last {health.windowDays} days.
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

function RunTable({ runs }: { runs: IngestRunRow[] }) {
  return (
    <Panel
      title="Recent collector runs"
      description="The 30 most recent, newest first."
    >
      {runs.length === 0 ? (
        <Empty>
          The collector has never recorded a run in this database. Either it has
          not been pointed here yet, or it has never started.
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
                      className={
                        "inline-block rounded border px-1.5 py-0.5 text-xs font-medium " +
                        TONE_BADGE[RUN_STATUS_TONE[run.status]]
                      }
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

function DataGapTable({ gaps }: { gaps: DataGapRow[] }) {
  const overwritten = gaps.filter((gap) => gap.cause === "roll_overwrite");

  return (
    <Panel
      title="Recorded data gaps — periods we did not collect"
      description="A gap means we were not watching. Before concluding equipment was off, check whether we were even reading."
    >
      {gaps.length === 0 ? (
        <Empty>No gaps recorded.</Empty>
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
                        className={
                          "inline-block rounded border px-1.5 py-0.5 text-xs font-medium " +
                          TONE_BADGE[
                            gap.cause === "roll_overwrite" ? "bad" : "warn"
                          ]
                        }
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
