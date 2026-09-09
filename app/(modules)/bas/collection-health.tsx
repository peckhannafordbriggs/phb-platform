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
  computeHeadroom,
  describeHeadroom,
  type Tone,
} from "./health-client";
import {
  ALL_SITES,
  DAYS_PARAM,
  PROJECT_PARAM,
  SITE_PARAM,
  STATION_PARAM,
  readFilters,
  withCascade,
  withFilter,
} from "./filters";
import { describeHiddenRisk, scopeSuffix } from "@/lib/modules/bas/types";
import { TONE_INK, TONE_STYLE, TONE_WASH } from "./tone";

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

  // All FOUR controls live in the URL, not in React state, so they survive a
  // tab switch, a refresh and a bookmark. See filters.ts. The filtering itself
  // still happens in SQL - see lib/modules/bas/service.ts, `resolveSelection`.
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { siteId, windowDays, projectId, stationId } =
    readFilters(searchParams);

  const setParam = (key: string, value: string | null) => {
    router.replace(`${pathname}${withFilter(searchParams, key, value)}`, {
      scroll: false,
    });
  };

  /** A cascade level: changes this one and clears everything below it. */
  const setCascade = (key: string, value: string | null) => {
    router.replace(`${pathname}${withCascade(searchParams, key, value)}`, {
      scroll: false,
    });
  };

  const load = useCallback(
    async (
      selection: {
        days: number;
        siteId: string | null;
        projectId: string | null;
        stationId: string | null;
      },
      options: { quiet?: boolean } = {},
    ) => {
      if (options.quiet !== true) setLoading(true);
      try {
        const data = await fetchCollectionHealth({
          days: selection.days,
          siteId: selection.siteId,
          projectId: selection.projectId,
          stationId: selection.stationId,
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
    void load({ days: windowDays, siteId, projectId, stationId });
  }, [load, windowDays, siteId, projectId, stationId]);

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
    if (error?.code !== "not_found") return;

    // Clear the DEEPEST level first. A 404 says one of the three no longer
    // resolves, and dropping the narrowest is the smallest change that can
    // recover - clearing all three would throw away a project selection that
    // was probably still fine.
    const stale =
      stationId !== null
        ? STATION_PARAM
        : siteId !== null
          ? SITE_PARAM
          : projectId !== null
            ? PROJECT_PARAM
            : null;

    if (stale !== null) {
      router.replace(`${pathname}${withCascade(searchParams, stale, null)}`, {
        scroll: false,
      });
    }
  }, [error, siteId, projectId, stationId, router, pathname, searchParams]);

  // Same shape as the mailbox workspace: poll only while the tab is visible,
  // catch up on return, and never leave a timer behind.
  //
  // The ref carries the CURRENT selection, not the one that was current when the
  // timer was installed. Without it the poll would quietly revert the screen to
  // seven days and all buildings a minute after someone changed a control - and
  // with four controls there is four times as much to silently revert.
  const pollRef = useRef<() => void>(() => {});
  pollRef.current = () => {
    void load(
      { days: windowDays, siteId, projectId, stationId },
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
          onClick={() =>
            void load({ days: windowDays, siteId, projectId, stationId })
          }
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

  // What the tiles are counting, and what they are not. Both come from the
  // service so the scope line, the tile suffixes and the banner cannot describe
  // the same selection three different ways.
  const suffix = scopeSuffix(health.scope);
  const hiddenRisk = describeHiddenRisk(health);

  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          {/*
            Project -> Building -> JACE, left to right, each defaulting to All.
            Changing one CLEARS everything below it (withCascade): a building
            that is not in the selected project makes the server answer 404, so
            without the clear the cascade would be a dead end rather than a
            filter.
          */}
          <Picker
            label="Project"
            value={health.selectedProjectId}
            onChange={(v) => setCascade(PROJECT_PARAM, v)}
            options={health.projects.map((row) => [row.projectId, row.name])}
          />
          <Picker
            label="Building"
            value={health.selectedSiteId}
            onChange={(v) => setCascade(SITE_PARAM, v)}
            options={health.sites.map((row) => [row.siteId, row.name])}
          />
          <Picker
            label="JACE"
            value={health.selectedStationId}
            onChange={(v) => setCascade(STATION_PARAM, v)}
            options={health.stations.map((row) => [row.stationId, row.name])}
          />

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
        controls that set it. Four controls change what every panel means, and a
        reader who has lost track of which one is set cannot tell a real zero
        from a filtered one.
      */}
      <p className="-mt-3 text-xs text-[var(--muted)]">
        {health.scope.filtered && health.scope.label !== null ? (
          <span className="font-medium text-[var(--foreground)]">
            {health.scope.label}
          </span>
        ) : (
          "All buildings"
        )}
        {" · "}
        {describeScope(null, health.windowDays)} · as of{" "}
        {formatTimestamp(health.observedAt)} · refreshes every minute while this
        tab is open
      </p>

      {/*
        THE TRAP.

        Every tile below counts only the filtered set. That is correct, and it
        is also how somebody filters to one building, reads "0 points at risk",
        and concludes nothing anywhere is at risk. Three outages have already
        destroyed about 117 hours per point, and one of them sat unnoticed in
        the database for eight days.

        So a filtered view is never allowed to look healthier than the estate
        is. `describeHiddenRisk` is a pure function in the service's types
        module - the rule is worth testing without rendering anything.
      */}
      {hiddenRisk !== null && (
        <p
          className="rounded-md border px-4 py-2.5 text-sm"
          style={{ ...TONE_STYLE.warn, color: TONE_INK.warn }}
          role="status"
        >
          {hiddenRisk}
        </p>
      )}

      {/* ------------------------------------------------------------- hero */}

      {/*
        At-risk is the hero because it is the question the screen exists to
        answer. Everything else here is context for it.

        Its badge is HEADROOM - hours until the station starts overwriting data
        nobody collected. That is the BAS equivalent of the reference
        dashboards' "+38% this week", and deliberately a different idiom: a
        comparison dashboard asks whether a number moved, and this one asks how
        much time is left. Inventing a week-over-week delta for "4 active points"
        would have been filling a shape.
      */}
      <HeroTile
        // The label carries the scope, so "Points at risk of data loss" never
        // reads as a claim about the whole estate while a filter is on.
        label={`Points at risk of data loss${suffix}`}
        value={formatCount(totals.pointsAtRisk)}
        tone={atRiskTone(totals.riskCounts)}
        headline={
          totals.pointsAtRisk > 0
            ? describeAtRisk(totals.riskCounts)
            : `Nothing at risk${suffix}`
        }
        badge={describeHeadroom(computeHeadroom(health.points))}
        detail={
          totals.pointsAtRisk > 0 && atRiskShape(totals.riskCounts) === "unknown"
            ? "Nothing is lost yet."
            : undefined
        }
      >
        {totals.pointsAtRisk > 0 && (
          <ul className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-sm">
            {riskBreakdown(totals.riskCounts).map(({ risk, count }) => (
              <li key={risk} title={RISK_EXPLANATION[risk]} className="tabular-nums">
                <span className="font-semibold">{formatCount(count)}</span>{" "}
                <span className="opacity-75">{RISK_LABEL[risk].toLowerCase()}</span>
              </li>
            ))}
          </ul>
        )}
      </HeroTile>

      {/* ------------------------------------------- runs: the wide chart */}

      <RunChart health={health} />

      {/* -------------------------------------------------- secondary row */}

      <section
        aria-label="Collection summary"
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
      >
        <Tile
          label={`Active points${suffix}`}
          value={formatCount(totals.activePoints)}
          tone={activePointsTone()}
          /*
            A live ratio rather than a static count. It goes to "3 of 4" the
            moment something stops reporting, which a bare 4 never would.
          */
          badge={`${formatCount(reportingPoints(health.points))} of ${formatCount(
            totals.activePoints,
          )} reporting`}
          // Decorative fill, and only ever a colour the semantic set does not
          // use - see .card--tinted in globals.css.
          tint="var(--phb-cyan)"
        />

        <Tile
          label={`Total readings${suffix}`}
          value={formatCount(totals.totalReadings)}
          tone={totalReadingsTone()}
        />

        <Tile
          label={`Unclassified points${suffix}`}
          value={formatCount(totals.unclassifiedPoints)}
          tone={unclassifiedTone(totals.unclassifiedPoints)}
          detail={
            totals.unclassifiedPoints === 0 ? undefined : "A backlog, not a fault."
          }
        />

        <Tile
          label={`Since newest reading${suffix}`}
          value={formatMinutes(totals.minutesSinceNewestReading)}
          tone={stalenessTone(totals.minutesSinceNewestReading)}
          // Not a delta - a reference value, so the number above is judgeable.
          badge="every 15 min"
          detail={
            totals.minutesSinceNewestReading === null
              ? "No readings at all — not a healthy zero."
              : undefined
          }
        />
      </section>

      {/* -------------------------------------------------- collector silence */}

      {gapSentence !== null && (
        <section
          className="card p-5 text-sm"
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

      <RunTable health={health} />

      {/* ------------------------------------------------------ recorded gaps */}

      <DataGapTable gaps={health.dataGaps} siteName={health.selectedSiteName} />
    </div>
  );
}

// ------------------------------------------------------------------ pieces

/**
 * A badge in the corner of a tile.
 *
 * The reference dashboards put a delta here. BAS has none worth showing, so what
 * sits here instead is whatever is genuinely live about that tile - headroom,
 * a reporting ratio, an expected cadence. Never a manufactured percentage.
 */
function Badge({ children, tone }: { children: React.ReactNode; tone: Tone }) {
  return (
    <span
      className="shrink-0 rounded-full px-2.5 py-1 text-[0.6875rem] font-medium tabular-nums"
      style={{ ...TONE_STYLE[tone], color: TONE_INK[tone] }}
    >
      {children}
    </span>
  );
}

function Tile({
  label,
  value,
  tone,
  detail,
  headline,
  stripe = false,
  badge,
  tint,
  children,
}: {
  label: string;
  value: string;
  tone: Tone;
  detail?: string;
  headline?: string;
  /**
   * A severity bar down the left edge, carried only by a tile reporting possible
   * data loss - it is what keeps "we might be losing data" distinguishable from
   * "this is less useful than it could be" when both are amber.
   */
  stripe?: boolean;
  badge?: string;
  /**
   * A decorative wash, for rhythm rather than meaning.
   *
   * Only ever cyan, purple or pink - the three quadrant colours the semantic set
   * does not use. Teal, orange and maroon mean ok / warn / bad here, so a card
   * tinted for rhythm can never be read as a card tinted for state.
   */
  tint?: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={
        "card tile-wash relative overflow-hidden px-5 py-4 " +
        (stripe ? "pl-6 " : "") +
        (tint !== undefined ? "card--tinted" : "")
      }
      style={{
        ...TONE_STYLE[tone],
        ...TONE_WASH[tone],
        ...(tint !== undefined
          ? ({ "--card-tint": `color-mix(in srgb, ${tint} 14%, transparent)` } as React.CSSProperties)
          : {}),
      }}
    >
      {stripe && (
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-0 w-1"
          style={{ background: TONE_INK[tone] }}
        />
      )}

      <div className="flex items-start justify-between gap-3">
        <p className="text-[0.625rem] font-medium uppercase tracking-[0.1em] text-[var(--muted)]">
          {label}
        </p>
        {badge !== undefined && <Badge tone={tone}>{badge}</Badge>}
      </div>

      <p
        className="mt-1.5 font-display text-[2.125rem] font-semibold leading-none tabular-nums"
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

/**
 * The hero: at-risk, filled and large.
 *
 * Same component shape as a Tile and deliberately not a variant prop - the hero
 * is a different composition, not a bigger tile, and collapsing them would mean
 * every size change to one silently moved the other.
 */
function HeroTile({
  label,
  value,
  tone,
  headline,
  badge,
  detail,
  children,
}: {
  label: string;
  value: string;
  tone: Tone;
  headline: string;
  badge: string;
  detail?: string;
  children?: React.ReactNode;
}) {
  return (
    <section
      className="card tile-wash relative overflow-hidden px-7 py-6"
      style={{ ...TONE_STYLE[tone], ...TONE_WASH[tone] }}
    >
      {/* The severity bar, at hero weight. */}
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-0 w-1.5"
        style={{ background: TONE_INK[tone] }}
      />

      <div className="flex flex-wrap items-start justify-between gap-4 pl-2">
        <p className="text-[0.6875rem] font-medium uppercase tracking-[0.12em] text-[var(--muted)]">
          {label}
        </p>
        <Badge tone={tone}>{badge}</Badge>
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-x-5 gap-y-1 pl-2">
        <p
          className="font-display text-[4rem] font-semibold leading-none tabular-nums"
          style={{ color: TONE_INK[tone] }}
        >
          {value}
        </p>
        <p className="pb-1 text-base font-medium" style={{ color: TONE_INK[tone] }}>
          {headline}
        </p>
      </div>

      <div className="pl-2">{children}</div>

      {detail !== undefined && (
        <p className="mt-3 pl-2 text-xs text-[var(--muted)]">{detail}</p>
      )}
    </section>
  );
}

/**
 * Active points that are actually reporting.
 *
 * Anything in the `ok` risk state: collected inside half its roll horizon. A
 * point that has never been collected, or whose horizon nobody filled in, is not
 * reporting for this purpose - the ratio would otherwise call a silent sensor
 * healthy.
 */
function reportingPoints(points: { risk: RollRisk }[]): number {
  return points.filter((point) => point.risk === "ok").length;
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
        // Taller than anything beside it: it is the one time series on the
        // screen, and everything else here is a single number.
        <div className="h-[22rem] px-3 pb-3 pt-1">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={health.runRecords}
              margin={{ top: 8, right: 8, bottom: 4, left: 4 }}
            >
              {/* Dotted and horizontal only. A reference, not a feature. */}
              <CartesianGrid
                stroke="var(--neutral-200)"
                strokeDasharray="2 4"
                vertical={false}
              />
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
                cursor={{ fill: "var(--neutral-100)" }}
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
                  borderRadius: "0.625rem",
                }}
              />
              <defs>
                <linearGradient id="basRunBar" x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="0%"
                    stopColor="var(--module-accent, var(--phb-cyan))"
                    stopOpacity={0.95}
                  />
                  <stop
                    offset="100%"
                    stopColor="var(--module-accent, var(--phb-cyan))"
                    stopOpacity={0.35}
                  />
                </linearGradient>
              </defs>
              <Bar
                dataKey="recordsWritten"
                fill="url(#basRunBar)"
                barSize={6}
                radius={[3, 3, 0, 0]}
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
      // Survives the cut: somebody will read a gap as equipment being off.
      description="A gap means we were not watching, not that equipment was off."
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
          {/*
            Capped and scrolled, like the collector runs table above. The list
            grows without limit - one row per recorded gap, forever - and an
            unbounded table pushes everything below it off the page.

            The red summary line is deliberately OUTSIDE this container. It is
            the honest headline about permanently destroyed data, and it has to
            be readable without scrolling, always. Moving it inside would let
            the one sentence that matters scroll away from the rows it counts.

            max-h-72 is about seven rows plus the header at this row height.
          */}
          <div className="max-h-72 overflow-auto">
            <table className="w-full min-w-[46rem] border-collapse text-sm">
              {/*
                Sticky, so you can still tell which column you are reading
                halfway down. Needs its own background or the rows show through,
                and z-10 so the tone badges in the cells do not paint over it.
              */}
              <thead className="sticky top-0 z-10 bg-[var(--surface)] text-left">
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
    <div className="space-y-7" aria-hidden="true">
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
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="border-t border-[var(--border)] px-3 py-3">
            <div className="h-3 w-1/2 animate-pulse rounded bg-[var(--border)]" />
          </div>
        ))}
      </div>
    </div>
  );
}


/**
 * One level of the Project -> Building -> JACE cascade.
 *
 * Always offers All and always defaults to it: nobody should have to drill
 * three levels to see everything. Disabled only when there is genuinely nothing
 * to choose from, which after a narrowing above is a real state - a project
 * with no JACEs yet - and reads better as an empty control than as one holding
 * a stale value.
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
