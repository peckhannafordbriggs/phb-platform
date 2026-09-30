import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

// collection-health.tsx is a client component whose top-level hooks need a
// router; the check components call none of them, but the module has to import.
vi.mock("next/navigation", () => ({
  usePathname: () => "/bas",
  useRouter: () => ({ replace: () => undefined, push: () => undefined }),
  useSearchParams: () => new URLSearchParams(""),
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  FailedChecks,
  PassedChecks,
  evaluateChecks,
} from "@/app/(modules)/bas/collection-health";
import { FigureBlock } from "@/app/(platform)/figure-block";
import { basFigure } from "@/lib/home/bas-figure";
import type {
  CollectionHealth,
  Completeness,
  RollRisk,
} from "@/lib/modules/bas/types";

/**
 * Quiet when fine, loud when broken (2026-09-29).
 *
 * The BAS screens stopped narrating themselves when nothing is wrong. What
 * this file exists to prove is the other half: that the FAILURE states
 * survived the diet. Every element that was collapsed or quieted is driven
 * here into its unhealthy state, and the full wording it always had is
 * asserted on the rendered HTML - a station count mismatch, a vanished
 * point, points at risk on the Home tile. Mutating the collapse to swallow
 * the unhealthy state too (return null from FailedChecks unconditionally,
 * drop `alarm` from basFigure) fails the tests below by name.
 *
 * The healthy states are asserted too, so the quiet line and the calm tile
 * are pinned as well as the loud ones.
 */

const risks = (over: Partial<Record<RollRisk, number>> = {}): Record<RollRisk, number> => ({
  ok: 0,
  at_risk: 0,
  data_lost: 0,
  buffer_not_full: 0,
  roll_horizon_unknown: 0,
  never_collected: 0,
  ...over,
});

const completeness = (
  over: Partial<Record<Completeness, number>> = {},
): Record<Completeness, number> => ({
  complete: 0,
  incomplete: 0,
  backfilling: 0,
  unknown: 0,
  ...over,
});

/** A payload as the service would return it, healthy unless overridden. */
function health(over: {
  totals?: Partial<CollectionHealth["totals"]>;
  points?: CollectionHealth["points"];
  vanished?: CollectionHealth["vanished"];
  scope?: CollectionHealth["scope"];
  unfiltered?: CollectionHealth["unfiltered"];
} = {}): CollectionHealth {
  return {
    windowDays: 7,
    sites: [],
    projects: [],
    stations: [],
    selectedSiteId: null,
    selectedSiteName: null,
    selectedProjectId: null,
    selectedProjectName: null,
    selectedStationId: null,
    selectedStationName: null,
    scope: over.scope ?? { filtered: false, label: null },
    unfiltered: over.unfiltered ?? null,
    observedAt: "2026-09-29T12:00:00.000Z",
    totals: {
      activePoints: 26,
      totalReadings: 87_100,
      unclassifiedPoints: 0,
      pointsAtRisk: 0,
      riskCounts: risks({ ok: 26 }),
      hiddenPoints: 0,
      hiddenPointsAtRisk: 0,
      pointsNoLongerReported: 0,
      pointsIncomplete: 0,
      completenessCounts: completeness({ complete: 26 }),
      minutesSinceNewestReading: 2,
      ...over.totals,
    },
    points: over.points ?? [],
    vanished: over.vanished ?? [],
    runs: [],
    newestRunAt: "2026-09-29T11:58:00.000Z",
    runRecords: [],
    longestRunGap: null,
    dataGaps: [],
  };
}

const shortPoint: CollectionHealth["points"][number] = {
  pointId: "1",
  pointName: "Unit_Status_Mode",
  siteName: "PHBoffice",
  pointRole: null,
  unit: null,
  risk: "ok",
  lastReadingAt: "2026-09-29T11:55:00.000Z",
  minutesAgo: 5,
  rollHorizonHours: 2,
  horizonSource: "measured",
  horizon: { state: "measured", hours: 2, currentHours: 2, stationCount: 500, capacity: 500 },
  completeness: "incomplete",
  stationCount: 500,
  heldCount: 430,
  visible: true,
};

const render = (
  component: typeof FailedChecks | typeof PassedChecks,
  data: CollectionHealth,
  suffix = "",
) => renderToStaticMarkup(createElement(component, { health: data, suffix }));

// ------------------------------------------------- the two checks, collapsed

describe("when both checks pass, one line stands where two cards were", () => {
  it("renders the compact checks line and no card", () => {
    const data = health();
    expect(evaluateChecks(data)).toEqual({ completenessOk: true, vanishedOk: true });

    const line = render(PassedChecks, data);
    expect(line).toContain('data-testid="bas-checks-passed"');
    expect(line).toContain("Checks:");
    expect(line).toContain("station counts match · no vanished points");

    expect(render(FailedChecks, data)).toBe("");
  });

  it("carries the scope suffix, so a filtered pass is not an estate pass", () => {
    const data = health({ scope: { filtered: true, label: "Liberty Center" } });
    expect(render(PassedChecks, data, " in Liberty Center")).toContain(
      "Checks in Liberty Center:",
    );
  });

  it("says nothing about a healthy check in prose - no 'Every point matches', no 'No point has vanished'", () => {
    const line = render(PassedChecks, health());
    expect(line).not.toContain("Every point matches");
    expect(line).not.toContain("No point has vanished");
    expect(line).not.toContain("Station count against ours");
    expect(line).not.toContain("No longer reported by the station");
  });
});

describe("a station count mismatch comes back as its full card", () => {
  const data = health({
    totals: {
      pointsIncomplete: 1,
      completenessCounts: completeness({ complete: 25, incomplete: 1 }),
    },
    points: [shortPoint],
  });

  it("is judged failed by the same check that judged the healthy screen passed", () => {
    expect(evaluateChecks(data)).toEqual({ completenessOk: false, vanishedOk: true });
  });

  it("renders the card with the wording it always had, and the point by name", () => {
    const cards = render(FailedChecks, data);
    expect(cards).toContain('aria-label="Completeness against the station"');
    expect(cards).toContain("Station count against ours");
    expect(cards).toContain("1 point short of what the station holds");
    expect(cards).toContain("Unit_Status_Mode");
    expect(cards).toContain("500 on the station, 430 here");
    // Red: the card's tone is the bad one, not a muted line.
    expect(cards).toContain("--phb-maroon");
  });

  it("keeps the other check on the line, and only that one", () => {
    const line = render(PassedChecks, data);
    expect(line).toContain("Checks:");
    expect(line).toContain("no vanished points");
    expect(line).not.toContain("station counts match");
  });

  it("is loud from a backfilling or unchecked point too, not only from incomplete", () => {
    for (const counts of [
      completeness({ complete: 25, backfilling: 1 }),
      completeness({ complete: 25, unknown: 1 }),
    ]) {
      const partial = health({ totals: { completenessCounts: counts } });
      expect(evaluateChecks(partial).completenessOk).toBe(false);
      expect(render(FailedChecks, partial)).toContain("Station count against ours");
      expect(render(PassedChecks, partial)).not.toContain("station counts match");
    }
  });
});

describe("a vanished point comes back as its full card", () => {
  const data = health({
    totals: { pointsNoLongerReported: 1 },
    vanished: [
      {
        pointId: "7",
        pointName: "Occupied",
        siteName: "PHBoffice",
        stationName: "PHBoffice",
        lastReadingAt: "2026-08-12T14:30:00.000Z",
      },
    ],
  });

  it("is judged failed", () => {
    expect(evaluateChecks(data)).toEqual({ completenessOk: true, vanishedOk: false });
  });

  it("renders the card with the wording it always had, and the point by name", () => {
    const cards = render(FailedChecks, data);
    expect(cards).toContain('aria-label="Points no longer reported by the station"');
    expect(cards).toContain("No longer reported by the station");
    expect(cards).toContain("1 point is no longer reported by its station");
    expect(cards).toContain("Check in Workbench");
    expect(cards).toContain("Occupied");
    expect(cards).toContain("last record");
    expect(cards).toContain("--phb-orange");
  });

  it("keeps the other check on the line, and only that one", () => {
    const line = render(PassedChecks, data);
    expect(line).toContain("station counts match");
    expect(line).not.toContain("no vanished points");
  });

  it("is not passed by a filtered zero when vanished points sit outside the filter (B7.6)", () => {
    const filtered = health({
      scope: { filtered: true, label: "Liberty Center" },
      unfiltered: { activePoints: 40, pointsAtRisk: 0, pointsNoLongerReported: 2 },
    });
    expect(evaluateChecks(filtered).vanishedOk).toBe(false);
    const cards = render(FailedChecks, filtered, " in Liberty Center");
    expect(cards).toContain("No point has vanished from its station in Liberty Center");
    expect(cards).toContain("2 more outside Liberty Center");
    expect(render(PassedChecks, filtered, " in Liberty Center")).not.toContain(
      "no vanished points",
    );
  });
});

describe("when both checks fail there is no line at all", () => {
  it("renders two cards and nothing quiet", () => {
    const data = health({
      totals: {
        pointsNoLongerReported: 1,
        completenessCounts: completeness({ complete: 24, incomplete: 1 }),
      },
      points: [shortPoint],
      vanished: [
        { pointId: "7", pointName: "Occupied", siteName: "PHBoffice", stationName: "PHBoffice", lastReadingAt: null },
      ],
    });
    const cards = render(FailedChecks, data);
    expect(cards).toContain("Station count against ours");
    expect(cards).toContain("No longer reported by the station");
    expect(cards).toContain("never received");
    expect(render(PassedChecks, data)).toBe("");
  });
});

// ------------------------------------------------------------ the Home tile

describe("the Home tile leads with the state", () => {
  it("at zero: the headline is 'No points at risk', the small line the newest reading's age, no mark", () => {
    const figure = basFigure({ pointsAtRisk: 0, minutesSinceNewestReading: 2 });
    expect(figure).toEqual({
      state: "none",
      value: "No points at risk",
      status: "newest reading 2 min ago",
    });

    const html = renderToStaticMarkup(createElement(FigureBlock, { figure }));
    expect(html).toContain(">No points at risk<");
    expect(html).toContain("newest reading 2 min ago");
    expect(html).not.toContain("home-figure-alarm");
    expect(html).not.toContain("--phb-maroon");
  });

  it("at one: the headline is '1 point at risk', marked red", () => {
    const figure = basFigure({ pointsAtRisk: 1, minutesSinceNewestReading: 2 });
    expect(figure).toMatchObject({ state: "ok", value: "1 point at risk", alarm: true });

    const html = renderToStaticMarkup(createElement(FigureBlock, { figure }));
    expect(html).toContain('data-testid="home-figure-alarm"');
    expect(html).toContain(">1 point at risk<");
    expect(html).toContain("background:var(--phb-maroon)");
    expect(html).toContain("newest reading 2 min ago");
  });

  it("at three: '3 points at risk', and the same mark", () => {
    const html = renderToStaticMarkup(
      createElement(FigureBlock, {
        figure: basFigure({ pointsAtRisk: 3, minutesSinceNewestReading: 190 }),
      }),
    );
    expect(html).toContain(">3 points at risk<");
    expect(html).toContain('data-testid="home-figure-alarm"');
    expect(html).toContain("newest reading 3 h 10 min ago");
  });

  it("is marked exactly when the count is above zero - the tile never looks calmer than the screen", () => {
    for (let atRisk = 0; atRisk <= 5; atRisk += 1) {
      const figure = basFigure({ pointsAtRisk: atRisk, minutesSinceNewestReading: 1 });
      const marked = figure.state === "ok" && figure.alarm === true;
      expect(marked).toBe(atRisk > 0);
    }
  });

  it("never carries headroom or 'not full yet' - those belong to Collection Health", () => {
    const figure = basFigure({ pointsAtRisk: 0, minutesSinceNewestReading: 2 });
    const text = `${figure.state === "unavailable" ? "" : figure.value} ${figure.status}`;
    expect(text).not.toMatch(/headroom/i);
    expect(text).not.toMatch(/not full/i);
  });

  it("says 'No readings yet' for a database with none, never an age of zero", () => {
    const figure = basFigure({ pointsAtRisk: 0, minutesSinceNewestReading: null });
    expect(figure.status).toBe("No readings yet");
  });
});

// ---------------------------------------------------- the prose that went

const SCREENS = [
  "app/(modules)/bas/collection-health.tsx",
  "app/(modules)/bas/point-explorer.tsx",
  "app/(modules)/bas/settings-view.tsx",
  "app/(modules)/bas/analyze.tsx",
  "app/(modules)/bas/health-client.ts",
  "app/(modules)/bas/analyze-client.ts",
] as const;

const source = async (file: string) =>
  (await readFile(path.join(process.cwd(), file), "utf8"))
    // Strip comments: the reasoning may quote the old sentence, the JSX may not.
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("the meta-commentary is gone from every BAS screen", () => {
  const GONE = [
    "refreshes every minute",
    "A backlog, not a fault",
    "Dashed outlines are",
    "Not limited to the window",
    "would make the chart unusable",
    "Read-only. The question becomes",
    "end to end",
    "Unticking Shown hides a point from Point Explorer",
    "Roles and\n        equipment are edited in a later phase",
    "not a healthy zero",
    "running it read-only, then",
    "no unit recorded for this point",
    "values in ${unit}",
  ];

  for (const file of SCREENS) {
    it(`${file} explains no feature, no design and none of its own drawing`, async () => {
      const text = await source(file);
      for (const sentence of GONE) {
        expect(text, sentence).not.toContain(sentence);
      }
    });
  }
});

describe("the sentences that stop a number being misread stayed", () => {
  it("keeps the gap-means-not-watching line on both gap tables", async () => {
    const health = await source("app/(modules)/bas/collection-health.tsx");
    const explorer = await source("app/(modules)/bas/point-explorer.tsx");
    const line = "A gap means we were not watching, not that equipment was off.";
    expect(health).toContain(line);
    expect(explorer).toContain(line);
  });

  it("keeps the findings about the building", async () => {
    const client = await source("app/(modules)/bas/health-client.ts");
    expect(client).toContain("Reads as a stuck sensor, not a stable room");
    expect(client).toContain("against a ${horizon} roll horizon");
    expect(client).toContain("a sensor fault, not a missing row");
    expect(client).toContain("not because the equipment was off");
  });

  it("keeps the rows-are-right line on an Analyze answer", async () => {
    const analyze = await source("app/(modules)/bas/analyze.tsx");
    expect(analyze).toMatch(/where\s+they disagree, the rows are right/);
  });
});

// ---------------------------------------------------------- every table scrolls

describe("every table in the module scrolls, using the one pattern", () => {
  const BOX = /className="[^"]*\bmax-h-72 overflow-auto\b[^"]*"/g;
  const STICKY = /<thead className="sticky top-0 z-10 bg-\[var\(--surface\)\][^"]*"/g;

  it.each([
    ["app/(modules)/bas/collection-health.tsx", 3],
    ["app/(modules)/bas/point-explorer.tsx", 1],
    ["app/(modules)/bas/settings-view.tsx", 1],
    ["app/(modules)/bas/analyze.tsx", 1],
  ])("%s: each <table> sits in a capped box with a sticky header (%i)", async (file, tables) => {
    const text = await source(file);
    expect((text.match(/<table/g) ?? []).length).toBe(tables);
    expect((text.match(BOX) ?? []).length).toBe(tables);
    expect((text.match(STICKY) ?? []).length).toBe(tables);
    // No second pattern: no other max-height on a table box.
    expect(text).not.toMatch(/max-h-(?!72 overflow-auto)\d+ overflow-auto/);
  });

  it("puts the row count beside every scrolling table's heading", async () => {
    const health = await source("app/(modules)/bas/collection-health.tsx");
    expect(health).toContain("count={points.length}");
    expect(health).toContain("count={runs.length}");
    expect(health).toContain("count={gaps.length}");
    const explorer = await source("app/(modules)/bas/point-explorer.tsx");
    expect(explorer).toContain("count={gaps.length}");
    const analyze = await source("app/(modules)/bas/analyze.tsx");
    expect(analyze).toContain("Rows the database returned (${table.rowCount})");
  });
});
