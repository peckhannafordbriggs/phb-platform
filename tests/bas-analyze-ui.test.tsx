import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Result } from "@/app/(modules)/bas/analyze";
import {
  cellText,
  describeGaps,
  describeRowCount,
  describeScope,
  describeUnknownHorizon,
  gapsTone,
  resultHeading,
  resultTone,
} from "@/app/(modules)/bas/analyze-client";
import type { AnalyzeResult, Provenance } from "@/lib/modules/bas/analyze/types";

/**
 * What the screen SAYS for each outcome - pure functions, and the real
 * `Result` component rendered to static markup.
 *
 * The one assertion this file exists for is the first: a `no_data` result and
 * an `answered` result whose value is 0 must not read alike. docs/BAS-B5.md
 * makes it an acceptance criterion, and it is the easiest thing in the tab to
 * regress by accident - a refactor that rendered every result through one
 * "answer" string would pass every other test.
 */

const provenance: Provenance = {
  timeRange: { start: "2026-09-14T00:00:00.000Z", end: "2026-09-21T00:00:00.000Z" },
  scope: "declared",
  points: [{ id: "1", name: "Zone Temp", site: "PHBoffice", station: "JACE", collected: true }],
  gaps: {
    totalHours: 64,
    items: [
      {
        pointId: "1",
        pointName: "Zone Temp",
        start: "2026-09-17T12:00:00.000Z",
        end: "2026-09-20T04:00:00.000Z",
        hours: 64,
        cause: "collector_down",
      },
    ],
  },
  unknownHorizon: { count: 0, names: [] },
  coverage: {
    earliest: "2026-09-01T00:00:00.000Z",
    latest: "2026-09-21T00:00:00.000Z",
    readings: 1200,
    neverCollected: [],
  },
  unclassifiedExcluded: 0,
};

const table = (rows: (string | number | boolean | null)[][]) => ({
  columns: ["avg_temp"],
  rows,
  rowCount: rows.length,
  truncated: false,
  rowCap: 200,
});

const noData: AnalyzeResult = {
  kind: "no_data",
  reason: "no_rows",
  explanation: "The query returned no rows. That is not an answer of zero: no data matched.",
  sql: "SELECT avg(value_num) AS avg_temp FROM bas_readings WHERE false",
  interpretation: "Average over nothing.",
  table: table([]),
  provenance,
  durationMs: 1200,
  retried: false,
};

const zero: AnalyzeResult = {
  kind: "answered",
  answer: "The average was 0 fahrenheit, with 64 hours of the period unrecorded.",
  interpretation: "Average of Zone Temp over the week.",
  sql: "SELECT avg(value_num) AS avg_temp FROM bas_readings WHERE point_id = 1",
  table: table([[0]]),
  provenance,
  durationMs: 1300,
  retried: false,
};

function render(result: AnalyzeResult): string {
  return renderToStaticMarkup(createElement(Result, { result, asked: "average?" }));
}

describe("zero rows renders differently from a zero result", () => {
  it("gives them different headings and tones", () => {
    expect(resultHeading(noData)).toBe("No data matched");
    expect(resultHeading(zero)).toBe("Answer");
    expect(resultTone(noData)).toBe("warn");
    expect(resultTone(zero)).toBe("neutral");
  });

  it("renders them as different markup, with the words that matter", () => {
    const empty = render(noData);
    const answered = render(zero);

    expect(empty).not.toBe(answered);

    expect(empty).toContain("No data matched");
    expect(empty).toContain("not an answer of zero");
    expect(empty).toContain("Zero rows. There is no table to show");
    expect(empty).not.toContain("<td");

    expect(answered).toContain(">Answer<");
    expect(answered).toContain("<td");
    expect(answered).toMatch(/<td[^>]*>0<\/td>/);
    expect(answered).not.toContain("No data matched");
  });

  it("renders the all-NULL row as the word NULL, never blank", () => {
    const allNull: AnalyzeResult = { ...noData, reason: "all_null", table: table([[null]]) };
    const html = render(allNull);
    expect(html).toContain("every cell is NULL");
    expect(html).toMatch(/<td[^>]*>NULL<\/td>/);
    expect(cellText(null)).toBe("NULL");
    expect(cellText(0)).toBe("0");
    expect(cellText(false)).toBe("false");
  });
});

describe("provenance is on screen for every result that ran", () => {
  it("shows the gap hours, the SQL and the row count on both", () => {
    for (const html of [render(noData), render(zero)]) {
      expect(html).toContain("What was actually queried");
      expect(html).toContain("64 hours of this period");
      expect(html).toContain("collector down");
      expect(html).toContain("SELECT avg(value_num)");
      expect(html).toContain("Zone Temp");
    }
  });

  it("labels the model's paragraph as the model's", () => {
    expect(render(zero)).toContain("the model&#x27;s reading of the rows below");
  });

  it("says when a retry happened", () => {
    expect(render({ ...zero, retried: true })).toContain("a second was requested");
    expect(render(zero)).not.toContain("a second was requested");
  });
});

describe("the gap sentence has three states, not two", () => {
  it("zero overlapping gaps is a sentence, and green", () => {
    const none: Provenance = { ...provenance, gaps: { totalHours: 0, items: [] } };
    expect(describeGaps(none)).toContain("No recorded gap overlaps");
    expect(gapsTone(none)).toBe("ok");
  });

  it("gaps present is a sentence with the hours, and amber", () => {
    expect(describeGaps(provenance)).toContain("64 hours of this period");
    expect(describeGaps(provenance)).toContain("The platform was not watching");
    expect(gapsTone(provenance)).toBe("warn");
  });

  it("not computed is its own sentence, and amber - never 'no gaps'", () => {
    const uncomputed: Provenance = { ...provenance, gaps: null, timeRange: null };
    expect(describeGaps(uncomputed)).toContain("could not be computed");
    expect(describeGaps(uncomputed)).not.toContain("No recorded gap");
    expect(gapsTone(uncomputed)).toBe("warn");
  });

  it("does not apply to a query that reads no readings, and is neutral", () => {
    const none: Provenance = { ...provenance, gaps: null, timeRange: null, scope: "none", points: [] };
    expect(describeGaps(none)).toContain("does not apply");
    expect(gapsTone(none)).toBe("neutral");
  });

  it("says when the figure is over every point because the plan named none", () => {
    const widened: Provenance = { ...provenance, scope: "all_points" };
    expect(describeGaps(widened)).toContain("across every point");
    expect(describeScope(widened)).toContain("did not name which ones");
  });
});

describe("the other sentences", () => {
  it("names unknown-horizon points and says what it means", () => {
    const text = describeUnknownHorizon({
      ...provenance,
      unknownHorizon: { count: 2, names: ["A", "B"] },
    });
    expect(text).toContain("2 points in scope have an unknown roll horizon (A, B)");
    expect(text).toContain("overwritten before collection");
    expect(describeUnknownHorizon(provenance)).toBe("");
  });

  it("says a capped result is the first N of more", () => {
    expect(describeRowCount({ ...table([[1]]), truncated: true, rowCount: 200 })).toContain(
      "First 200 rows of more",
    );
    expect(describeRowCount(table([[1]]))).toBe("1 row");
  });

  it("renders the honest outcomes with their own headings", () => {
    const clarify: AnalyzeResult = {
      kind: "clarify",
      question: "Which building?",
      interpretation: "Two match.",
    };
    const cannot: AnalyzeResult = {
      kind: "cannot_answer",
      reason: "bas_equipment is empty.",
      attempts: [{ sql: "SELECT 1", error: "permission denied" }],
      retried: true,
    };
    const notConfigured: AnalyzeResult = { kind: "not_configured", missing: ["ANTHROPIC_API_KEY"] };

    expect(render(clarify)).toContain("One question first");
    expect(render(clarify)).toContain("Nothing was queried");
    expect(render(cannot)).toContain("Could not answer");
    expect(render(cannot)).toContain("permission denied");
    expect(render(cannot)).toContain("a second was requested");
    expect(render(notConfigured)).toContain("ANTHROPIC_API_KEY");
    expect(render(notConfigured)).toContain("rest of Building Automation is unaffected");
  });
});
