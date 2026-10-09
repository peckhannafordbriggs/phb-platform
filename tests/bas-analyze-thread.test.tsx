// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * The Analyze thread: layout and daily lifetime.
 *
 *  - two turns render in the order asked, and only the older one's rows
 *    table is folded (a <details> behind the line it already carried);
 *  - a reload on the same day restores the thread from the browser, with no
 *    request to the server;
 *  - a thread dated yesterday is discarded on load, not shown;
 *  - "New conversation" clears the screen and the storage;
 *  - while a question is being worked on, the pending turn is in the thread,
 *    the ask box is disabled, and a second question cannot be sent.
 *
 * The day is drawn in America/New_York (lib/activity/rollover.ts). The pure
 * storage rules are held below without rendering anything.
 *
 * MUTATION RECORD, 2026-10-09. Each applied by hand, the named test failed,
 * then reverted.
 *   - analyze-thread.ts: loadThread returns whichever day's thread the
 *     employee has and deletes nothing -> "discards the employee's other
 *     days", "does not match its key" and "dated yesterday is discarded"
 *     fail.
 *   - analyze.tsx: every turn rendered compact -> "only the older one folds
 *     its rows" fails (the newest is a <details>).
 *   - analyze.tsx: the busy guard dropped from submit -> "nothing else can
 *     be sent" fails (two POSTs).
 */

import { Analyze } from "@/app/(modules)/bas/analyze";
import {
  THREAD_VERSION,
  loadThread,
  saveThread,
  threadDay,
  threadKey,
  type AnalyzeTurn,
} from "@/app/(modules)/bas/analyze-thread";
import type { AnalyzeResult, Provenance } from "@/lib/modules/bas/analyze/types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// ------------------------------------------------------------------ fixtures

const provenance: Provenance = {
  timeRange: { start: "2026-10-01T00:00:00.000Z", end: "2026-10-08T00:00:00.000Z" },
  scope: "declared",
  points: [{ id: "1", name: "Zone Temp", site: "PHBoffice", station: "JACE", collected: true }],
  gaps: { totalHours: 0, mergedRows: 0, items: [] },
  unknownHorizon: { count: 0, names: [] },
  coverage: {
    earliest: "2026-09-01T00:00:00.000Z",
    latest: "2026-10-08T00:00:00.000Z",
    readings: 1200,
    neverCollected: [],
  },
  unclassifiedExcluded: 0,
  periodUndeclared: false,
  coverageShortfall: null,
};

function answered(answer: string): AnalyzeResult {
  return {
    kind: "answered",
    answer,
    interpretation: "Average over the week.",
    sql: "SELECT avg(value_num) FROM bas_readings",
    table: { columns: ["avg"], rows: [[71.5]], rowCount: 1, truncated: false, rowCap: 200 },
    provenance,
    durationMs: 1200,
    retried: false,
  };
}

const EMPLOYEE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
/** 3 PM in Cincinnati on 9 October 2026 (EDT): 19:00Z. */
const NOW = new Date("2026-10-09T19:00:00.000Z");
const TODAY = "2026-10-09";

function turn(id: string, question: string, answer: string): AnalyzeTurn {
  return {
    id,
    askedAt: NOW.toISOString(),
    question,
    outcome: { kind: "result", result: answered(answer) },
  };
}

// ------------------------------------------------------------------ render

const roots: Array<{ root: Root; host: HTMLDivElement }> = [];

async function render(now: Date = NOW): Promise<HTMLDivElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push({ root, host });
  await act(async () => {
    root.render(createElement(Analyze, { employeeId: EMPLOYEE, now: () => now }));
  });
  await settle();
  return host;
}

async function unmountAll(): Promise<void> {
  for (const { root, host } of roots.splice(0)) {
    await act(async () => root.unmount());
    host.remove();
  }
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Type into the textarea the way React sees it, then press Enter. */
async function ask(host: HTMLElement, question: string): Promise<void> {
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(textarea, question);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  await settle();
}

const askedTexts = (host: HTMLElement) =>
  [...host.querySelectorAll('[data-testid="bas-analyze-turn"] header p:nth-child(2)')].map(
    (p) => p.textContent,
  );

let fetchMock: ReturnType<typeof vi.fn>;
/** Answers for POSTs, in order; a function returns a promise the test controls. */
let answers: Array<Response | (() => Promise<Response>)>;
let posts: number;

beforeEach(() => {
  window.localStorage.clear();
  answers = [];
  posts = 0;
  fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts += 1;
      const next = answers.shift();
      if (next === undefined) throw new Error("no scripted answer left");
      return typeof next === "function" ? next() : next;
    }
    return jsonResponse({ data: { configured: true, missing: [] } });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  await unmountAll();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ------------------------------------------------------------------- tests

describe("the storage rules, without a screen", () => {
  it("keys a thread by employee and New York calendar day", () => {
    expect(threadDay(NOW)).toBe(TODAY);
    // 11 PM in Cincinnati is already the 10th in UTC and still the 9th here.
    expect(threadDay(new Date("2026-10-10T03:30:00.000Z"))).toBe(TODAY);
    expect(threadKey(EMPLOYEE, TODAY)).toBe(`phb.bas.analyze.thread:${EMPLOYEE}:${TODAY}`);
  });

  it("round-trips today's thread, discards the employee's other days, leaves other people alone", () => {
    const storage = window.localStorage;
    saveThread(storage, EMPLOYEE, "2026-10-08", [turn("y", "yesterday?", "Y")]);
    saveThread(storage, EMPLOYEE, TODAY, [turn("t", "today?", "T")]);
    saveThread(storage, OTHER, "2026-10-08", [turn("o", "theirs?", "O")]);

    const turns = loadThread(storage, EMPLOYEE, TODAY);
    expect(turns.map((t) => t.question)).toEqual(["today?"]);
    expect(storage.getItem(threadKey(EMPLOYEE, "2026-10-08"))).toBeNull();
    expect(storage.getItem(threadKey(OTHER, "2026-10-08"))).not.toBeNull();
  });

  it("treats a record that does not match its key, or does not parse, as absent", () => {
    const storage = window.localStorage;
    storage.setItem(
      threadKey(EMPLOYEE, TODAY),
      JSON.stringify({ version: THREAD_VERSION, employeeId: OTHER, day: TODAY, turns: [turn("x", "q", "a")] }),
    );
    expect(loadThread(storage, EMPLOYEE, TODAY)).toEqual([]);
    storage.setItem(threadKey(EMPLOYEE, TODAY), "{not json");
    expect(loadThread(storage, EMPLOYEE, TODAY)).toEqual([]);
    expect(loadThread(null, EMPLOYEE, TODAY)).toEqual([]);
  });

  it("drops the oldest turns from the stored copy when storage refuses the size", () => {
    const limit = JSON.stringify(turn("2", "second question?", "B")).length * 2;
    const items = new Map<string, string>();
    const tight: Storage = {
      get length() {
        return items.size;
      },
      key: (i) => [...items.keys()][i] ?? null,
      getItem: (k) => items.get(k) ?? null,
      setItem: (k, v) => {
        if (v.length > limit + 120) throw new DOMException("quota", "QuotaExceededError");
        items.set(k, v);
      },
      removeItem: (k) => void items.delete(k),
      clear: () => items.clear(),
    };
    const stored = saveThread(tight, EMPLOYEE, TODAY, [
      turn("1", "first question?", "A"),
      turn("2", "second question?", "B"),
      turn("3", "third question?", "C"),
    ]);
    expect(stored).toBeLessThan(3);
    expect(stored).toBeGreaterThan(0);
    const back = loadThread(tight, EMPLOYEE, TODAY).map((t) => t.question);
    expect(back[back.length - 1]).toBe("third question?");
  });
});

describe("the thread on screen", () => {
  it("two turns, in the order asked, and only the older one folds its rows", async () => {
    answers = [jsonResponse({ data: answered("First answer.") }), jsonResponse({ data: answered("Second answer.") })];
    const host = await render();
    expect(host.querySelector('[data-testid="bas-analyze-thread"]')).toBeNull();

    await ask(host, "first question?");
    await ask(host, "second question?");

    expect(askedTexts(host)).toEqual(["first question?", "second question?"]);
    const rows = [...host.querySelectorAll('[data-testid="bas-analyze-rows"]')];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.tagName).toBe("DETAILS");
    expect(rows[0]!.getAttribute("data-folded")).toBe("true");
    expect((rows[0] as HTMLDetailsElement).open).toBe(false);
    expect(rows[0]!.querySelector("summary")!.textContent).toBe("Rows the database returned (1)");
    expect(rows[1]!.tagName).toBe("DIV");
    expect(rows[1]!.getAttribute("data-folded")).toBe("false");
    expect(rows[1]!.querySelector("table")).not.toBeNull();

    // Nothing else about the older turn is folded or removed.
    const older = host.querySelectorAll('[data-testid="bas-analyze-turn"]')[0]!;
    expect(older.textContent).toContain("First answer.");
    expect(older.textContent).toContain("What was actually queried");
    expect(older.textContent).toContain("Gaps in the period");
    expect(older.querySelector("table")).not.toBeNull();

    // The ask box is at the bottom, after the thread.
    const thread = host.querySelector('[data-testid="bas-analyze-thread"]')!;
    const form = host.querySelector("form")!;
    expect(thread.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("a reload on the same day restores the thread without asking the server again", async () => {
    answers = [jsonResponse({ data: answered("Kept.") })];
    const first = await render();
    await ask(first, "will this survive?");
    expect(posts).toBe(1);
    await unmountAll();

    const second = await render(new Date("2026-10-09T23:30:00.000Z")); // 7:30 PM, same day
    expect(askedTexts(second)).toEqual(["will this survive?"]);
    expect(second.textContent).toContain("Kept.");
    expect(posts).toBe(1);
  });

  it("a thread dated yesterday is discarded on load, not shown", async () => {
    saveThread(window.localStorage, EMPLOYEE, "2026-10-08", [turn("y", "yesterday's question?", "Old.")]);
    const host = await render();
    expect(host.querySelector('[data-testid="bas-analyze-thread"]')).toBeNull();
    expect(host.textContent).not.toContain("yesterday's question?");
    expect(window.localStorage.getItem(threadKey(EMPLOYEE, "2026-10-08"))).toBeNull();
    expect(host.textContent).toContain("Things people ask");
  });

  it("New conversation clears the screen and the storage, and the examples return", async () => {
    answers = [jsonResponse({ data: answered("Gone soon.") })];
    const host = await render();
    await ask(host, "clear me?");
    expect(window.localStorage.getItem(threadKey(EMPLOYEE, TODAY))).not.toBeNull();

    const button = host.querySelector('[data-testid="bas-analyze-new-conversation"]') as HTMLButtonElement;
    expect(button.textContent).toBe("New conversation");
    await act(async () => button.click());
    await settle();

    expect(host.querySelector('[data-testid="bas-analyze-thread"]')).toBeNull();
    expect(window.localStorage.getItem(threadKey(EMPLOYEE, TODAY))).toBeNull();
    expect(host.querySelector('[data-testid="bas-analyze-new-conversation"]')).toBeNull();
    expect(host.textContent).toContain("Things people ask");
  });

  it("while an answer is being worked on, the question sits in the thread and nothing else can be sent", async () => {
    let release: (value: Response) => void = () => {};
    answers = [() => new Promise<Response>((resolve) => (release = resolve))];
    const host = await render();

    await ask(host, "slow question?");
    const pending = host.querySelector('[data-testid="bas-analyze-pending"]')!;
    expect(pending).not.toBeNull();
    expect(pending.textContent).toContain("slow question?");
    expect(pending.textContent).toContain("Working…");
    expect(pending.querySelector('[aria-busy="true"]')).not.toBeNull();
    const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
    expect((host.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);

    // A second question while the first is out: nothing is sent.
    await ask(host, "second question?");
    expect(posts).toBe(1);
    expect(host.querySelectorAll('[data-testid="bas-analyze-pending"]')).toHaveLength(1);

    await act(async () => release(jsonResponse({ data: answered("Done.") })));
    await settle();
    expect(host.querySelector('[data-testid="bas-analyze-pending"]')).toBeNull();
    expect(askedTexts(host)).toEqual(["slow question?"]);
    expect(textarea.disabled).toBe(false);
  });

  it("a request that fails is a turn too, with the existing message, and stays in the thread", async () => {
    answers = [
      jsonResponse({ error: { code: "rate_limited", message: "slow down" } }, 429),
      jsonResponse({ data: answered("After.") }),
    ];
    const host = await render();
    await ask(host, "too fast?");
    await ask(host, "then this?");

    const turns = [...host.querySelectorAll('[data-testid="bas-analyze-turn"]')];
    expect(turns).toHaveLength(2);
    expect(turns[0]!.getAttribute("role") ?? turns[0]!.querySelector('[role="alert"]')).not.toBeNull();
    expect(turns[0]!.textContent).toContain("too fast?");
    expect(turns[1]!.textContent).toContain("After.");
  });
});
