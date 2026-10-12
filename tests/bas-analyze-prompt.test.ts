import { describe, expect, it } from "vitest";
import { planUserMessage } from "@/lib/modules/bas/analyze/planner";
import type { PriorTurn } from "@/lib/modules/bas/analyze/types";

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
