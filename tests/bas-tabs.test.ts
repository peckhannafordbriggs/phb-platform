import { describe, expect, it } from "vitest";
import {
  BAS_TABS,
  activeTabHref,
  basTab,
  tabHref,
} from "@/app/(modules)/bas/tabs";
import {
  ALL_SITES,
  DAYS_PARAM,
  POINT_PARAM,
  SITE_PARAM,
  readFilters,
  withFilter,
} from "@/app/(modules)/bas/filters";
import {
  DEFAULT_WINDOW_DAYS,
  describeDistinctValues,
  describeNullRecords,
  distinctValuesTone,
  axisLabel,
  formatValue,
} from "@/app/(modules)/bas/health-client";

/**
 * The tab shell and the URL-backed filters, as pure functions.
 *
 * The suite has no DOM, so what is provable here is the routing arithmetic and
 * the rules - which is the part that has to be right. A tab that looks wrong is
 * noticed; a filter that silently resets is not.
 */

describe("the tabs are real routes", () => {
  it("registers Collection Health at /bas and Point Explorer at /bas/points", () => {
    expect(BAS_TABS.map((tab) => tab.href)).toEqual(["/bas", "/bas/points"]);
  });

  it("gives every tab a label and a blurb", () => {
    for (const tab of BAS_TABS) {
      expect(tab.label.length).toBeGreaterThan(0);
      expect(tab.blurb.length).toBeGreaterThan(20);
      // A real route, not a fragment or a query - so it bookmarks, refreshes and
      // middle-clicks.
      expect(tab.href.startsWith("/bas")).toBe(true);
      expect(tab.href).not.toContain("#");
      expect(tab.href).not.toContain("?");
    }
  });

  it("looks a tab up by href and fails loudly on a typo", () => {
    expect(basTab("/bas").label).toBe("Collection Health");
    expect(basTab("/bas/points").label).toBe("Point Explorer");
    expect(() => basTab("/bas/nope")).toThrow();
  });
});

describe("which tab is active", () => {
  it("does not light up Collection Health on every path", () => {
    // Every BAS path starts with /bas, so a naive startsWith would mark the
    // first tab active on all of them. Longest match wins.
    expect(activeTabHref("/bas")).toBe("/bas");
    expect(activeTabHref("/bas/points")).toBe("/bas/points");
  });

  it("keeps the tab active on a child route", () => {
    // A future /bas/points/41 is still the Point Explorer tab.
    expect(activeTabHref("/bas/points/41")).toBe("/bas/points");
  });

  it("respects segment boundaries", () => {
    // /bas/pointsomething is not the Point Explorer.
    expect(activeTabHref("/bas/pointsomething")).toBe("/bas");
  });

  it("returns null outside the module", () => {
    expect(activeTabHref("/change-orders")).toBeNull();
    expect(activeTabHref("/")).toBeNull();
  });
});

describe("filters survive a tab switch", () => {
  it("carries the whole query string onto the other tab", () => {
    // The requirement this exists for: selecting a building on one tab and
    // having it reset on the next makes the filter untrustworthy, and an
    // untrustworthy filter is worse than none - a filtered zero and a real zero
    // look identical.
    const params = new URLSearchParams("site=5&days=1&point=41");

    expect(tabHref("/bas/points", params)).toBe("/bas/points?site=5&days=1&point=41");
    expect(tabHref("/bas", params)).toBe("/bas?site=5&days=1&point=41");
  });

  it("carries a tab-local filter too, so switching away and back restores it", () => {
    // `point` means nothing to Collection Health, which ignores it. Carrying it
    // anyway is what returns you to the point you were looking at.
    const params = new URLSearchParams("point=41");

    expect(tabHref("/bas", params)).toContain("point=41");
  });

  it("leaves a clean href when nothing is selected", () => {
    expect(tabHref("/bas/points", new URLSearchParams())).toBe("/bas/points");
  });
});

describe("reading filters out of a URL", () => {
  const read = (query: string) => readFilters(new URLSearchParams(query));

  it("defaults to all buildings, the default window and the first point", () => {
    expect(read("")).toEqual({
      siteId: null,
      windowDays: DEFAULT_WINDOW_DAYS,
      pointId: null,
    });
  });

  it("reads a full selection", () => {
    expect(read("site=5&days=30&point=41")).toEqual({
      siteId: "5",
      windowDays: 30,
      pointId: "41",
    });
  });

  it("treats the All sentinel as no building", () => {
    // The sentinel is a <select> implementation detail and must never reach the
    // server as a site id.
    expect(read(`${SITE_PARAM}=${ALL_SITES}`).siteId).toBeNull();
    expect(read("site=").siteId).toBeNull();
  });

  it("falls back rather than throwing on a hand-edited URL", () => {
    // These arrive from a URL a person may have typed. The server validates
    // again anyway, so the screen should render and explain rather than fail
    // before it can.
    expect(read("days=lots").windowDays).toBe(DEFAULT_WINDOW_DAYS);
    expect(read("days=").windowDays).toBe(DEFAULT_WINDOW_DAYS);
  });
});

describe("writing a filter back to the URL", () => {
  const params = (query: string) => new URLSearchParams(query);

  it("sets a value and preserves the others", () => {
    expect(withFilter(params("site=5&point=41"), DAYS_PARAM, "30")).toBe(
      "?site=5&point=41&days=30",
    );
  });

  it("removes the parameter rather than writing an empty one", () => {
    expect(withFilter(params("site=5&days=30"), SITE_PARAM, null)).toBe("?days=30");
    expect(withFilter(params("site=5"), SITE_PARAM, ALL_SITES)).toBe("");
  });

  it("does not restate the default window", () => {
    // A URL should carry choices, not defaults. /bas beats /bas?days=7.
    expect(withFilter(params(""), DAYS_PARAM, String(DEFAULT_WINDOW_DAYS))).toBe("");
    expect(withFilter(params("site=5"), DAYS_PARAM, String(DEFAULT_WINDOW_DAYS))).toBe(
      "?site=5",
    );
  });

  it("keeps a non-default window", () => {
    expect(withFilter(params(""), DAYS_PARAM, "1")).toBe("?days=1");
  });

  it("round-trips through readFilters", () => {
    const written = withFilter(params(""), POINT_PARAM, "41");
    expect(readFilters(new URLSearchParams(written)).pointId).toBe("41");
  });
});

describe("distinct values, not standard deviation", () => {
  /**
   * The rule this screen is judged on. A threshold on sigma is unit-dependent
   * and untunable across buildings - it missed a sensor frozen at 64.5 with
   * sigma 0.08, because a stuck sensor has a LOW standard deviation and so does
   * a genuinely stable room. Distinct-value count does not care about units.
   */
  it("calls a live sensor healthy", () => {
    // Measured on the live database: Temp1 gives 256 distinct across 286
    // readings in 24 hours.
    expect(distinctValuesTone(256, 286)).toBe("ok");
    expect(describeDistinctValues(256, 286)).toContain("physical world");
  });

  it("calls a frozen sensor bad, however stable it looks", () => {
    // The sensor stuck at 64.5. One value over hundreds of readings.
    expect(distinctValuesTone(1, 286)).toBe("bad");
    expect(describeDistinctValues(1, 286)).toContain("stuck sensor");
    // And it says so in a way that pre-empts the obvious objection.
    expect(describeDistinctValues(1, 286)).toContain("stable room");
  });

  it("walks Grafana's thresholds at 4 and 20", () => {
    expect(distinctValuesTone(3, 100)).toBe("bad");
    expect(distinctValuesTone(4, 100)).toBe("warn");
    expect(distinctValuesTone(19, 100)).toBe("warn");
    expect(distinctValuesTone(20, 100)).toBe("ok");
  });

  it("does not call 'no readings' a stuck sensor", () => {
    // No evidence is not bad evidence. Red here would be as wrong as green.
    expect(distinctValuesTone(0, 0)).toBe("neutral");
    expect(describeDistinctValues(0, 0)).toContain("nothing to judge");
  });

  it("handles a coarse but living sensor without crying stuck", () => {
    // points_RoomT reports to a coarser resolution: 28 distinct across 286.
    // Still comfortably alive.
    expect(distinctValuesTone(28, 286)).toBe("ok");
  });
});

describe("a null reading is not a missing reading", () => {
  it("says which of the two an empty-looking window is", () => {
    const noRows = describeNullRecords(0, 0);
    const noNulls = describeNullRecords(286, 0);

    expect(noRows).toContain("No rows at all");
    expect(noRows).toContain("nothing was collected");
    expect(noNulls).toContain("Every row carries a value");

    // The failure this prevents: both are "0 nulls" and they mean opposite
    // things.
    expect(noRows).not.toBe(noNulls);
  });

  it("describes a real null record as a sensor fault, not a gap", () => {
    const some = describeNullRecords(286, 3);

    expect(some).toContain("sensor fault");
    expect(some).toContain("not a missing row");
  });
});

describe("units are never left implicit", () => {
  it("labels the axis with the unit when there is one", () => {
    expect(axisLabel("fahrenheit")).toBe("fahrenheit");
  });

  it("says the unit is unknown rather than leaving the axis bare", () => {
    // Temp1..Temp3 carry no unit at all. A bare axis reads as "no unit needed"
    // rather than "unit unknown", and those are different claims.
    expect(axisLabel(null)).toContain("no unit");
  });

  it("renders a value with its unit, and without inventing one", () => {
    expect(formatValue(58.51, "fahrenheit")).toBe("58.51 fahrenheit");
    expect(formatValue(58.51, null)).toBe("58.51");
    expect(formatValue(null, "fahrenheit")).toBe("—");
  });
});
