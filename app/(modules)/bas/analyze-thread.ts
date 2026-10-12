import {
  PRIOR_CELL_MAX_CHARS,
  PRIOR_COLUMNS_MAX,
  PRIOR_ROWS_MAX,
  PRIOR_SQL_MAX_CHARS,
  PRIOR_TEXT_MAX_CHARS,
  PRIOR_TURNS_MAX,
  PRIOR_TURNS_MAX_BYTES,
  type AnalyzeResult,
  type Cell,
  type PriorTurn,
} from "@/lib/modules/bas/analyze/types";
import { APP_TIME_ZONE, calendarDay } from "@/lib/activity/rollover";

/**
 * The Analyze thread: what a day's questions look like in the browser, and
 * how they survive a reload of the tab.
 *
 * Pure. No DOM, no React: the component (analyze.tsx) hands this module a
 * `Storage` and a clock, and every rule here is proved in
 * tests/bas-analyze-thread.test.tsx without rendering anything.
 *
 * ONE TURN IS ONE QUESTION AND WHAT CAME BACK. The shape is deliberately the
 * same object the API returned (`AnalyzeResult`), unwrapped nowhere, so a
 * later step that hands prior turns to the planner can read a turn's
 * question, interpretation and SQL straight off it - every `answered` and
 * `no_data` result already carries both - without this file changing shape.
 * That later step is `priorTurnsFor` below (2026-10-09): the turns a
 * follow-up carries, cut down to what the planner needs and capped.
 *
 * THE THREAD LIVES FOR A CALENDAR DAY, IN THE COMPANY'S ZONE. The key is the
 * employee id and the day; on load, the day's thread is read and every other
 * day's thread for that employee is deleted rather than shown. The day is
 * `calendarDay` in `APP_TIME_ZONE` (America/New_York), the same boundary and
 * the same reasoning as Home's "last here" window (lib/activity/rollover.ts):
 * midnight UTC is 7 or 8 PM in Cincinnati, so a UTC day would wipe a
 * person's afternoon questions while they were still asking them, and the
 * browser's own zone would move the boundary with the laptop. Two people on
 * one machine have two keys, because the employee id is in it.
 *
 * CLIENT-SIDE ONLY, AND ONLY AS LONG AS THE TAB. `sessionStorage` since
 * 2026-10-12 (`localStorage` before that), nothing on the server: the audit
 * row each question already writes is the durable record (runbook.md,
 * *Analyze: reading the log of questions*), and this is a convenience for
 * the person at the keyboard. A reload of the same tab brings the thread
 * back; closing the tab or the browser starts fresh; and two tabs are two
 * independent conversations, because each tab has a session store of its
 * own - nothing here or on the server ties them together, and a follow-up
 * carries only the turns of the tab it was asked in. The day check still
 * applies within a tab: one left open past midnight resets on its next
 * load or its next question. Storage can be absent (a private window,
 * blocked site data), so every read and write is guarded and the screen
 * works without it - a thread then lasts as long as the page.
 *
 * `forgetLocalThreads` removes what the earlier `localStorage` copy left
 * behind: those keys were cleaned up by the load that no longer reads them,
 * so without it a few days of old threads would sit in every browser that
 * used the tab before the change, read by nothing and deleted by nothing.
 *
 * A PENDING QUESTION IS NOT SAVED. Only turns that have resolved are
 * written, so a reload mid-answer loses the question from the thread (the
 * server still answered it and recorded it). Writing the pending question
 * would mean showing, after a reload, a question with no answer and no way
 * to get one.
 */

export const THREAD_VERSION = 1;
export const THREAD_KEY_PREFIX = "phb.bas.analyze.thread";

/** One question and its outcome. `error` is a request that failed to return a result at all. */
export interface AnalyzeTurn {
  id: string;
  /** ISO instant the question was asked. */
  askedAt: string;
  question: string;
  outcome: { kind: "result"; result: AnalyzeResult } | { kind: "error"; message: string };
}

export interface AnalyzeThread {
  version: typeof THREAD_VERSION;
  employeeId: string;
  /** `YYYY-MM-DD` in APP_TIME_ZONE. */
  day: string;
  turns: AnalyzeTurn[];
}

/** The calendar day a thread belongs to, for an instant. */
export function threadDay(at: Date): string {
  return calendarDay(at, APP_TIME_ZONE);
}

export function threadKey(employeeId: string, day: string): string {
  return `${THREAD_KEY_PREFIX}:${employeeId}:${day}`;
}

function isTurn(value: unknown): value is AnalyzeTurn {
  if (typeof value !== "object" || value === null) return false;
  const turn = value as Record<string, unknown>;
  const outcome = turn.outcome as Record<string, unknown> | undefined;
  return (
    typeof turn.id === "string" &&
    typeof turn.askedAt === "string" &&
    typeof turn.question === "string" &&
    typeof outcome === "object" &&
    outcome !== null &&
    ((outcome.kind === "result" && typeof outcome.result === "object" && outcome.result !== null) ||
      (outcome.kind === "error" && typeof outcome.message === "string"))
  );
}

/**
 * Today's thread for this employee, and NOTHING from any other day: every
 * other day's key for the employee is removed on the way through, so a stale
 * thread is discarded on load rather than shown. Another employee's keys are
 * untouched. A thread that does not parse, or is for a different employee or
 * day than its key claims, is treated as absent.
 */
export function loadThread(
  storage: Storage | null,
  employeeId: string,
  day: string,
): AnalyzeTurn[] {
  if (storage === null) return [];
  try {
    const mine = `${THREAD_KEY_PREFIX}:${employeeId}:`;
    const stale: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key !== null && key.startsWith(mine) && key !== threadKey(employeeId, day)) {
        stale.push(key);
      }
    }
    for (const key of stale) storage.removeItem(key);

    const raw = storage.getItem(threadKey(employeeId, day));
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as Partial<AnalyzeThread> | null;
    if (
      parsed === null ||
      parsed.version !== THREAD_VERSION ||
      parsed.employeeId !== employeeId ||
      parsed.day !== day ||
      !Array.isArray(parsed.turns)
    ) {
      return [];
    }
    return parsed.turns.filter(isTurn);
  } catch {
    return [];
  }
}

/**
 * Write the thread. On a quota failure the OLDEST turns are dropped from the
 * stored copy, one at a time, until it fits - the screen keeps every turn for
 * the rest of the page's life; only what a reload will bring back shrinks.
 * Returns how many turns were stored.
 */
export function saveThread(
  storage: Storage | null,
  employeeId: string,
  day: string,
  turns: AnalyzeTurn[],
): number {
  if (storage === null) return 0;
  let kept = turns;
  while (true) {
    const thread: AnalyzeThread = { version: THREAD_VERSION, employeeId, day, turns: kept };
    try {
      storage.setItem(threadKey(employeeId, day), JSON.stringify(thread));
      return kept.length;
    } catch {
      if (kept.length === 0) return 0;
      kept = kept.slice(1);
    }
  }
}

export function clearThread(storage: Storage | null, employeeId: string, day: string): void {
  if (storage === null) return;
  try {
    storage.removeItem(threadKey(employeeId, day));
  } catch {
    // Nothing to clear, or nowhere to clear it from.
  }
}

/** `window.sessionStorage`, or null where it throws or does not exist. */
export function browserStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Remove every thread key the pre-2026-10-12 `localStorage` copy left in
 * this browser, for every employee: nothing reads them any more. Returns
 * how many were removed. Safe to call where storage is absent.
 */
export function forgetLocalThreads(local: Storage | null): number {
  if (local === null) return 0;
  try {
    const stale: string[] = [];
    for (let i = 0; i < local.length; i += 1) {
      const key = local.key(i);
      if (key !== null && key.startsWith(`${THREAD_KEY_PREFIX}:`)) stale.push(key);
    }
    for (const key of stale) local.removeItem(key);
    return stale.length;
  } catch {
    return 0;
  }
}

/** `window.localStorage`, for `forgetLocalThreads` only; null where it throws or does not exist. */
export function legacyLocalStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

export function newTurnId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // Fall through.
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ----------------------------------------------------- what a follow-up sends

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

const clipCell = (cell: Cell): Cell =>
  typeof cell === "string" ? clip(cell, PRIOR_CELL_MAX_CHARS) : cell;

/**
 * One turn as the planner should see it, or null for a turn that gives a
 * follow-up nothing to refer to (a failed request, a not-configured result).
 * See `PriorTurn` for what each field is for and why the rows are a sample.
 */
export function priorTurnOf(turn: AnalyzeTurn): PriorTurn | null {
  if (turn.outcome.kind !== "result") return null;
  const result = turn.outcome.result;
  const base = { id: turn.id, question: clip(turn.question, 1_000) };
  switch (result.kind) {
    case "answered":
    case "no_data": {
      const columns = result.table.columns.slice(0, PRIOR_COLUMNS_MAX).map((c) => clip(c, 64));
      const rows = result.table.rows
        .slice(0, PRIOR_ROWS_MAX)
        .map((row) => row.slice(0, PRIOR_COLUMNS_MAX).map(clipCell));
      return {
        ...base,
        kind: result.kind,
        interpretation: clip(result.interpretation, PRIOR_TEXT_MAX_CHARS),
        sql: clip(result.sql, PRIOR_SQL_MAX_CHARS),
        answer: clip(result.kind === "answered" ? result.answer : result.explanation, PRIOR_TEXT_MAX_CHARS),
        columns,
        rows,
        rowCount: result.table.rowCount,
        rowsArePartial:
          result.table.truncated ||
          rows.length < result.table.rowCount ||
          result.table.columns.length > PRIOR_COLUMNS_MAX,
      };
    }
    case "clarify":
      return {
        ...base,
        kind: "clarify",
        interpretation: clip(result.interpretation, PRIOR_TEXT_MAX_CHARS),
        sql: null,
        answer: clip(result.question, PRIOR_TEXT_MAX_CHARS),
        columns: [],
        rows: [],
        rowCount: null,
        rowsArePartial: false,
      };
    case "cannot_answer":
      return {
        ...base,
        kind: "cannot_answer",
        interpretation: null,
        sql: null,
        answer: clip(result.reason, PRIOR_TEXT_MAX_CHARS),
        columns: [],
        rows: [],
        rowCount: null,
        rowsArePartial: false,
      };
    case "from_prior":
      return {
        ...base,
        kind: "from_prior",
        interpretation: clip(result.interpretation, PRIOR_TEXT_MAX_CHARS),
        sql: null,
        answer: clip(result.answer, PRIOR_TEXT_MAX_CHARS),
        columns: [],
        rows: [],
        rowCount: null,
        rowsArePartial: false,
      };
    case "not_configured":
      return null;
  }
}

/**
 * The earlier turns a follow-up carries: the NEWEST that fit, in the order
 * asked. Walks back from the latest turn, adding while the count stays
 * within PRIOR_TURNS_MAX and the serialised size within
 * PRIOR_TURNS_MAX_BYTES; the first turn that would not fit stops the walk,
 * so what is sent is always a contiguous recent stretch and never a recent
 * turn missing with an older one present. An empty thread sends nothing -
 * the first question of a day, or after "New conversation", is the request
 * the tab has always sent.
 */
export function priorTurnsFor(turns: AnalyzeTurn[]): PriorTurn[] {
  const chosen: PriorTurn[] = [];
  let bytes = 2; // the array's own brackets
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const prior = priorTurnOf(turns[i]!);
    if (prior === null) continue;
    const size = JSON.stringify(prior).length + (chosen.length === 0 ? 0 : 1);
    if (chosen.length >= PRIOR_TURNS_MAX || bytes + size > PRIOR_TURNS_MAX_BYTES) break;
    chosen.unshift(prior);
    bytes += size;
  }
  return chosen;
}
