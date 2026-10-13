import { describe, expect, it } from "vitest";
import { SUMMARY_RULES, SYSTEM_RULES, planUserMessage, summaryUserMessage } from "@/lib/modules/bas/analyze/planner";
import type { PriorTurn, Provenance } from "@/lib/modules/bas/analyze/types";

/**
 * What the planner is SENT, without a model.
 *
 * The first question of a day carries no earlier-questions block at all -
 * the message is the one the tab sent before follow-ups existed, character
 * for character. A follow-up carries the earlier turns numbered from 1,
 * oldest first, inside a <data> block, and the question after them.
 */

const prior = (id: string, question: string): PriorTurn => ({
  id,
  question,
  kind: "answered",
  interpretation: "Stale points.",
  sql: "SELECT name FROM bas_v_point",
  answer: "Three points are stale.",
  columns: ["name"],
  rows: [["A"], ["B"], ["C"]],
  rowCount: 3,
  rowsArePartial: false,
});

describe("the plan call's user message", () => {
  it("a first question is the message the tab has always sent", () => {
    const message = planUserMessage({
      question: "What is stale?",
      nowUtc: "2026-10-09T19:00:00.000Z",
      previous: null,
      priorTurns: [],
    });
    expect(message).toBe(
      "Current time (UTC): 2026-10-09T19:00:00.000Z\n\n\nQuestion:\n<data>\nWhat is stale?\n</data>",
    );
    expect(message).not.toContain("Earlier questions");
  });

  it("a follow-up carries the earlier questions, numbered, oldest first, as data", () => {
    const message = planUserMessage({
      question: "Which of those was the worst?",
      nowUtc: "2026-10-09T19:00:00.000Z",
      previous: null,
      priorTurns: [prior("t1", "What is stale?"), prior("t2", "And yesterday?")],
    });
    expect(message).toContain("Earlier questions today, oldest first (JSON; 2):");
    const block = /<data>\n(\[.*\])\n<\/data>/s.exec(message)!;
    const turns = JSON.parse(block[1]!) as Array<{ n: number; question: string; rows_are_partial: boolean }>;
    expect(turns.map((t) => t.n)).toEqual([1, 2]);
    expect(turns.map((t) => t.question)).toEqual(["What is stale?", "And yesterday?"]);
    expect(turns[0]!.rows_are_partial).toBe(false);
    // The browser's id is not the model's business.
    expect(block[1]).not.toContain('"id"');
    // The question itself still comes last, in its own data block.
    expect(message.endsWith("Question:\n<data>\nWhich of those was the worst?\n</data>")).toBe(true);
  });

  it("a retry note sits between the earlier questions and the question", () => {
    const message = planUserMessage({
      question: "q",
      nowUtc: "2026-10-09T19:00:00.000Z",
      previous: { sql: "DELETE FROM x", error: "Only a SELECT" },
      priorTurns: [prior("t1", "earlier")],
    });
    expect(message.indexOf("Earlier questions")).toBeLessThan(message.indexOf("previous attempt"));
    expect(message.indexOf("previous attempt")).toBeLessThan(message.lastIndexOf("Question:"));
  });
});

/**
 * What the summariser is SENT (2026-10-13): the style rules that make the
 * paragraph read plainly, and the timezone material they depend on. The
 * rules that keep a number honest are asserted beside them, because the
 * plain style must never buy its readability by leaving a fact out.
 */
const provenance = (points: Provenance["points"]): Provenance => ({
  timeRange: { start: "2026-10-05T04:00:00.000Z", end: "2026-10-12T04:00:00.000Z" },
  scope: "declared",
  points,
  gaps: { totalHours: 6.5, mergedRows: 0, items: [] },
  unknownHorizon: { count: 0, names: [] },
  coverage: {
    earliest: "2026-02-01T05:00:00.000Z",
    latest: "2026-10-12T03:40:00.000Z",
    readings: 44_750,
    neverCollected: [],
  },
  unclassifiedExcluded: 0,
  periodUndeclared: false,
  coverageShortfall: null,
});

const table = { columns: ["avg"], rows: [[71.8]], rowCount: 1, truncated: false, rowCap: 200 };

describe("the summary call", () => {
  it("carries the plain-answer style rules, beside the rules that keep a number honest", () => {
    for (const phrase of [
      "29 September at 12:50 PM",
      "Never an ISO timestamp",
      "never UTC, unless the person asked",
      "No column or table names",
      'not "run_id 1037"',
      "about 8 weeks (1,330 hours)",
      "rather than restating the query",
      "Never leave a fact out",
    ]) {
      expect(SUMMARY_RULES, phrase).toContain(phrase);
    }
    expect(SUMMARY_RULES).toContain("State only numbers that appear in the rows");
    expect(SUMMARY_RULES).toContain("period_not_fully_covered");
    expect(SUMMARY_RULES).toContain("with N hours of the period unrecorded");
  });

  /**
   * docs/11-analyze-voice.md (2026-10-13). Section 6 is the one to be
   * paranoid about: the summariser must be TOLD never to present a possible
   * cause as a confirmed diagnosis, in those words, and the other sections
   * must be there beside it. The old four-sentence cap and the no-bullets
   * rule are gone on purpose - a ten-room answer needs a list.
   */
  it("carries the voice guideline: answer first, facts apart from causes, no diagnosis without evidence, old data with its age", () => {
    for (const phrase of [
      "experienced controls engineer",
      "The first sentence answers the question",
      "Match the detail to the question",
      "what to check next",
      "no long wall of text",
      'each line starting with "- "',
      "Keep the engineering detail that helps someone act",
      "commanded versus actual values",
      "a problem the rows confirm, a possible problem the rows suggest, a possible cause that needs checking, or something the rows cannot determine",
      "The readings don't confirm the cause yet",
      "Never present a possible cause as a confirmed diagnosis",
      "Never name a broken part the rows have not shown to be broken",
      "An unusual reading is not automatically a fault",
      "Never suggest changing equipment settings, overriding a setpoint or bypassing a safety or control",
      "Never pass an old reading off as the current condition",
      "Missing data is not equipment failure",
      "no bold or other markdown",
    ]) {
      expect(SUMMARY_RULES, phrase).toContain(phrase);
    }
    expect(SUMMARY_RULES).not.toContain("at most four short sentences");
    expect(SUMMARY_RULES).not.toContain("no bullet points");
  });

  it("the planner's messages take the same voice: plain words, no role codes, no UTC ranges, no diagnosis", () => {
    const section = SYSTEM_RULES.slice(SYSTEM_RULES.indexOf("# Voice of what the person reads"));
    expect(section.length).toBeGreaterThan(100);
    for (const phrase of [
      'say "room temperature", not zone_temp',
      "no UTC or ISO ranges",
      "no column, table or id names",
      "Never present a possible cause as a confirmed diagnosis",
      "how old the newest data is",
      "no bold or other markdown",
    ]) {
      expect(section, phrase).toContain(phrase);
    }
    // The record keeps its precision; only what the person reads changes.
    expect(section).toContain('The "interpretation" field is for the record and keeps its precise UTC range');
  });

  it("names the building's zone with a worked conversion, and renders the range and the span in it beside the UTC values", () => {
    const message = summaryUserMessage({
      question: "average?",
      interpretation: "Average over the week.",
      sql: "SELECT 1",
      table,
      provenance: provenance([
        { id: "1", name: "Zone Temp", site: "PHBoffice", station: "JACE", timezone: "America/Chicago", collected: true },
      ]),
      nowUtc: "2026-10-13T14:00:00.000Z",
    });
    expect(message).toContain("Timezone for dates and times in the answer: America/Chicago.");
    expect(message).toContain("Worked example: 2026-10-13T14:00:00.000Z is 13 October at 9:00 AM in that zone");
    expect(message).toContain('"timezone":"America/Chicago"');
    expect(message).toContain('"time_range_utc":{"start":"2026-10-05T04:00:00.000Z","end":"2026-10-12T04:00:00.000Z"}');
    expect(message).toContain('"time_range_local":{"start":"4 October at 11:00 PM","end":"11 October at 11:00 PM"}');
    expect(message).toContain('"readings_held_span_local":{"earliest":"31 January at 11:00 PM","latest":"11 October at 10:40 PM"}');
    // What was always sent is still sent: the question as data, the rows as data, the gap hours.
    expect(message).toContain("Question:\n<data>\naverage?\n</data>");
    expect(message).toContain('"gap_hours_inside_range":6.5');
    expect(message.endsWith('<data>\n{"columns":["avg"],"rows":[[71.8]]}\n</data>')).toBe(true);
  });

  it("falls back to the company's zone when no point is in scope or the points span two zones", () => {
    const none = summaryUserMessage({
      question: "runs?",
      interpretation: "x",
      sql: "SELECT 1",
      table,
      provenance: { ...provenance([]), scope: "none", timeRange: null, gaps: null, coverage: null },
      nowUtc: "2026-10-13T14:00:00.000Z",
    });
    expect(none).toContain("Timezone for dates and times in the answer: America/New_York.");
    expect(none).toContain("is 13 October at 10:00 AM in that zone");
    expect(none).toContain('"time_range_local":null');
    const two = summaryUserMessage({
      question: "both?",
      interpretation: "x",
      sql: "SELECT 1",
      table,
      provenance: provenance([
        { id: "1", name: "A", site: "S1", station: "J", timezone: "America/Chicago", collected: true },
        { id: "2", name: "B", site: "S2", station: "J", timezone: "America/Denver", collected: true },
      ]),
      nowUtc: "2026-10-13T14:00:00.000Z",
    });
    expect(two).toContain("Timezone for dates and times in the answer: America/New_York.");
  });
});
