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
  Completeness,
  DataGapRow,
  IngestRunRow,
  PointHealthRow,
  PointHorizon,
  RollRisk,
} from "@/lib/modules/bas/types";
import {
  ApiError,
  COMPLETENESS_EXPLANATION,
  COMPLETENESS_LABEL,
  RISK_EXPLANATION,
  RISK_LABEL,
  completenessBreakdown,
  completenessTileTone,
  completenessTone,
  describeCompleteness,
  describeHorizon,
  describeShortfall,
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
  describeHiddenFromTable,
  describeVanished,
  reportingPoints,
  splitHiddenPoints,
  vanishedTone,
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
import { unitSymbol } from "@/lib/modules/bas/units";
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
        {formatTimestamp(health.observedAt)}
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

      {/* ----------------------------------------------- checks that failed */}

      {/*
        A completeness shortfall or a vanished point comes here, at the top,
        as its full card. When both checks pass they are one quiet line
        further down (PassedChecks); see the two components for the rule.
      */}
      <FailedChecks health={health} suffix={suffix} />

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
        />

        <Tile
          label={`Since newest reading${suffix}`}
          value={formatMinutes(totals.minutesSinceNewestReading)}
          tone={stalenessTone(totals.minutesSinceNewestReading)}
          // Not a delta - a reference value, so the number above is judgeable.
          badge="every 15 min"
          // The dash above is not a zero, and the one sentence says which.
          detail={
            totals.minutesSinceNewestReading === null
              ? "No readings at all."
              : undefined
          }
        />
      </section>

      {/* ------------------------------------------------ checks that passed */}

      <PassedChecks health={health} suffix={suffix} />

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
 * The two checks that used to be two always-rendered cards: does the platform
 * hold what the station says it holds, and has any point vanished from its
 * station.
 *
 * Both checks run on every render, in both states - `evaluateChecks` is the
 * only place either verdict is decided, and the quiet line and the loud card
 * are two renderings of the same result. When both pass, ONE line of checks
 * sits where the cards were: "Checks: station counts match · no vanished
 * points". A check that fails comes back as its full card, in its tone, at
 * the top of the screen, with the wording it always had.
 *
 * The line exists for the reason the cards were always rendered: a card that
 * appears only when something is wrong cannot be told apart from a check
 * that stopped running. The line is that proof at one-tenth the height. What
 * changed is only how much a HEALTHY screen says about itself.
 *
 * "Passes" is stricter than "green". The vanished check passes only when the
 * count is zero AND nothing is hidden by the filter: a filtered zero with two
 * vanished points elsewhere is the B7.6 false calm, and it renders the full
 * card, which names them. tests/bas-quiet-ui.test.tsx drives every state.
 */
export function evaluateChecks(health: CollectionHealthData): {
  completenessOk: boolean;
  vanishedOk: boolean;
} {
  const completenessOk =
    completenessTileTone(health.totals.completenessCounts) === "ok";
  const vanished = health.totals.pointsNoLongerReported;
  const vanishedOk =
    vanishedTone(vanished) === "ok" && vanishedElsewhere(health) === 0;
  return { completenessOk, vanishedOk };
}

/** Vanished points outside the current filter: the B7.6 rule's count. */
function vanishedElsewhere(health: CollectionHealthData): number {
  return health.unfiltered !== null && health.scope.filtered
    ? health.unfiltered.pointsNoLongerReported -
        health.totals.pointsNoLongerReported
    : 0;
}

/** The failed checks, each as its full card. Nothing when both pass. */
export function FailedChecks({
  health,
  suffix,
}: {
  health: CollectionHealthData;
  suffix: string;
}) {
  const checks = evaluateChecks(health);
  if (checks.completenessOk && checks.vanishedOk) return null;
  return (
    <>
      {!checks.completenessOk && (
        <CompletenessCard health={health} suffix={suffix} />
      )}
      {!checks.vanishedOk && <VanishedCard health={health} suffix={suffix} />}
    </>
  );
}

/** The passed checks, as one line. Nothing when neither passes. */
export function PassedChecks({
  health,
  suffix,
}: {
  health: CollectionHealthData;
  suffix: string;
}) {
  const checks = evaluateChecks(health);
  const passed = [
    checks.completenessOk ? "station counts match" : null,
    checks.vanishedOk ? "no vanished points" : null,
  ].filter((check): check is string => check !== null);
  if (passed.length === 0) return null;
  return (
    <p
      className="text-xs text-[var(--muted)]"
      role="status"
      data-testid="bas-checks-passed"
    >
      <span className="font-medium" style={{ color: TONE_INK.ok }}>
        Checks{suffix}:
      </span>{" "}
      {passed.join(" · ")}
    </p>
  );
}

/**
 * Points the station stopped reporting (B8.3, and the hole found on
 * 18 September 2026).
 *
 * Rendered as a card only when it fails - see FailedChecks; the check runs
 * either way. Not folded into the at-risk hero - see `vanishedTone` for
 * why - and never silent, which is what this closes: the collector
 * deactivating a point used to remove it from every figure on this screen, so
 * a point VANISHING made the dashboard look better. The four deliberate
 * reasons (system log, alarm history, retired _cfg0 half, manual) are not
 * here; we chose those, and they cannot surprise us.
 */
function VanishedCard({
  health,
  suffix,
}: {
  health: CollectionHealthData;
  suffix: string;
}) {
  const count = health.totals.pointsNoLongerReported;
  const tone = vanishedTone(count);
  // The B7.6 rule, applied to this figure too: a vanished point outside the
  // filter is still said, so a filtered zero cannot read as an estate zero.
  const elsewhere = vanishedElsewhere(health);

  return (
    <section
      aria-label="Points no longer reported by the station"
      className="card p-5 text-sm"
      style={{ ...TONE_STYLE[tone], color: TONE_INK[tone] }}
    >
      <p className="font-display text-[0.8125rem] font-semibold uppercase tracking-[0.07em]">
        No longer reported by the station{suffix}
      </p>
      <p className="mt-1 font-medium">{describeVanished(count, suffix)}</p>
      {health.vanished.length > 0 && (
        <ul className="mt-3 space-y-1">
          {health.vanished.map((point) => (
            <li key={point.pointId} className="flex flex-wrap gap-x-3 tabular-nums">
              <span className="font-medium">{point.pointName}</span>
              <span className="opacity-75">
                {point.stationName} · {point.siteName}
              </span>
              <span className="opacity-75">
                last record{" "}
                {point.lastReadingAt === null
                  ? "never received"
                  : formatTimestamp(point.lastReadingAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {elsewhere > 0 && (
        <p className="mt-2 text-xs opacity-80">
          {elsewhere} more outside {health.scope.label ?? "this filter"}. Clear the
          filter to see {elsewhere === 1 ? "it" : "them"}.
        </p>
      )}
    </section>
  );
}

/**
 * Does the platform hold what the station says it holds?
 *
 * Rendered as a card only when the answer is no - see FailedChecks, and the
 * passed-checks line that stands in for it when the answer is yes. This check
 * exists because it spent a day writing verdicts nobody read. The names are
 * listed because "2 points short" sends somebody to a query and
 * "Unit_Status_Mode: 500 on the station, 430 here" sends them to Workbench.
 */
function CompletenessCard({
  health,
  suffix,
}: {
  health: CollectionHealthData;
  suffix: string;
}) {
  const counts = health.totals.completenessCounts;
  const tone = completenessTileTone(counts);
  const listed = health.points
    .filter((point) => point.completeness !== "complete")
    .sort(
      (a, b) =>
        COMPLETENESS_SEVERITY_ORDER_INDEX[a.completeness] -
          COMPLETENESS_SEVERITY_ORDER_INDEX[b.completeness] ||
        a.pointName.localeCompare(b.pointName),
    );

  return (
    <section
      aria-label="Completeness against the station"
      className="card p-5 text-sm"
      style={{ ...TONE_STYLE[tone], color: TONE_INK[tone] }}
    >
      <p className="font-display text-[0.8125rem] font-semibold uppercase tracking-[0.07em]">
        Station count against ours{suffix}
      </p>
      <p className="mt-1 font-medium">{describeCompleteness(counts)}</p>
      {completenessBreakdown(counts).length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-xs">
          {completenessBreakdown(counts).map(({ completeness, count }) => (
            <li
              key={completeness}
              title={COMPLETENESS_EXPLANATION[completeness]}
              className="tabular-nums"
            >
              <span className="font-semibold">{formatCount(count)}</span>{" "}
              <span className="opacity-75">
                {COMPLETENESS_LABEL[completeness].toLowerCase()}
              </span>
            </li>
          ))}
        </ul>
      )}
      {listed.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs">
          {listed.slice(0, 12).map((point) => (
            <li key={point.pointId} className="flex flex-wrap items-baseline gap-x-2">
              <CompletenessBadge completeness={point.completeness} />
              <span className="font-medium">{point.pointName}</span>
              <span className="opacity-75">{describeShortfall(point)}</span>
            </li>
          ))}
          {listed.length > 12 && (
            <li className="opacity-75">and {formatCount(listed.length - 12)} more in the table below</li>
          )}
        </ul>
      )}
    </section>
  );
}

const COMPLETENESS_SEVERITY_ORDER_INDEX: Record<Completeness, number> = {
  incomplete: 0,
  backfilling: 1,
  unknown: 2,
  complete: 3,
};

function CompletenessBadge({ completeness }: { completeness: Completeness }) {
  return (
    <span
      title={COMPLETENESS_EXPLANATION[completeness]}
      className="inline-block rounded-[2px] border px-1.5 py-0.5 text-[0.6875rem] font-medium"
      style={{
        ...TONE_STYLE[completenessTone(completeness)],
        color: TONE_INK[completenessTone(completeness)],
      }}
    >
      {COMPLETENESS_LABEL[completeness]}
    </span>
  );
}

/**
 * The roll-horizon cell, in the three distinct states (2026-09-18). One
 * component for this table and the Settings Points list, so the two screens
 * cannot drift into naming the same state two ways.
 */
export function HorizonCell({ horizon }: { horizon: PointHorizon }) {
  const words = describeHorizon(horizon);
  return (
    <span title={words.title} style={{ color: TONE_INK[words.tone] }}>
      {words.label}
      {words.detail !== null && (
        <span className="ml-1 text-xs opacity-70">{words.detail}</span>
      )}
    </span>
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
  count,
  description,
  children,
}: {
  title: string;
  /**
   * How many rows the panel holds, shown beside the title. For a panel whose
   * body scrolls, this is the only place the number is visible without
   * scrolling to the bottom, and a person should not have to guess it.
   */
  count?: number;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card overflow-hidden">
      <header className="px-5 pb-3 pt-4">
        <h2 className="font-display text-[0.8125rem] font-semibold uppercase tracking-[0.07em]">
          {title}
          {count !== undefined && (
            <span className="font-normal text-[var(--muted)]"> ({formatCount(count)})</span>
          )}
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

/**
 * Exported for tests/bas-health-point-table.test.ts, which renders it with the
 * real service's rows and reads the count and the scroll container off the
 * HTML. Used by nothing else.
 */
export function PointTable({
  points: allPoints,
  siteName,
}: {
  points: PointHealthRow[];
  siteName: string | null;
}) {
  // Hidden points leave THE TABLE and nothing else (B8.3). Every tile above
  // was computed by the service over all active points, hidden included, and
  // the panel says how many rows it is not drawing. See splitHiddenPoints.
  const { listed: points, hidden } = splitHiddenPoints(allPoints);
  const hiddenLine = describeHiddenFromTable(hidden.length);

  return (
    <Panel
      title="Per-point collection status"
      // The rows in the container below. With the body scrolling, the total
      // is no longer visible at the bottom of the list, so it is stated here.
      // Hidden points are not in it - the description line names those.
      count={points.length}
      description={hiddenLine ?? undefined}
    >
      {points.length === 0 ? (
        <Empty>
          {hidden.length > 0
            ? `Every active point${siteName === null ? "" : ` at ${siteName}`} is hidden from this table. The figures above still count ${hidden.length === 1 ? "it" : "them"}.`
            : siteName === null
              ? "No active points. Nothing has been discovered on the station yet, or every point has been marked inactive."
              : `No active points at ${siteName}. Another building may still have some — switch the filter to All.`}
        </Empty>
      ) : (
        /*
          Capped and scrolled, the same way the collector runs and data gaps
          tables are - one pattern, not a second one. max-h-72 is about seven
          rows plus the header at this row height. EVERY row is still in the
          DOM: the container clips what is visible, it does not slice the
          list, and nothing on this screen reads the viewport. The tiles, the
          hidden-risk sentence, the reporting ratio and the completeness card
          are computed from `health.totals` and the full `health.points`
          array, exactly as they were when the table ran the page long. A
          scroll container is one more way a screen can show less than it
          knows, and the figures must not follow it (B8.3's rule).

          At a few hundred points this is fine. At a station with 600 the
          plain list will get slow, and the answer then is virtualisation,
          not a smaller cap - see runbook.md, "The per-point table on
          Collection Health is slow".
        */
        <div className="max-h-72 overflow-auto">
          <table className="w-full min-w-[52rem] border-collapse text-sm">
            {/*
              Sticky, so the column headings stay put while the body scrolls.
              Its own background or the rows show through; z-10 so the tone
              badges in the cells do not paint over it.
            */}
            <thead className="sticky top-0 z-10 bg-[var(--surface)] text-left">
              <tr>
                <Th>Point</Th>
                <Th>Site</Th>
                <Th>Role</Th>
                <Th>Unit</Th>
                <Th>Risk</Th>
                <Th>Completeness</Th>
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
                    {unitSymbol(point.unit) ?? "—"}
                  </td>
                  <td className="px-3 py-2">
                    <RiskBadge risk={point.risk} />
                  </td>
                  <td className="px-3 py-2">
                    <CompletenessBadge completeness={point.completeness} />
                    {point.completeness !== "complete" &&
                      point.completeness !== "unknown" && (
                        <span className="ml-2 text-xs text-[var(--muted)] tabular-nums">
                          {describeShortfall(point)}
                        </span>
                      )}
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
                    <HorizonCell horizon={point.horizon} />
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
      count={runs.length}
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
        // The one scroll pattern: about seven rows, sticky header, the count
        // in the heading. Same box as the per-point and data-gaps tables.
        <div className="max-h-72 overflow-auto">
          <table className="w-full min-w-[34rem] border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-[var(--surface)] text-left">
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
      count={gaps.length}
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
              {overwritten.length === 1 ? " is a station overwrite" : " are station overwrites"}:
              the data existed, the station destroyed it before we read it, and
              it cannot be recovered.
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
