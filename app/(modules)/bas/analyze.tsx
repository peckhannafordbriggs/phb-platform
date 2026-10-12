"use client";

import { useEffect, useRef, useState } from "react";
import {
  browserStorage,
  clearThread,
  forgetLocalThreads,
  legacyLocalStorage,
  loadThread,
  newTurnId,
  priorTurnsFor,
  saveThread,
  threadDay,
  type AnalyzeTurn,
} from "./analyze-thread";
import type {
  AnalyzeResult,
  Provenance,
  ResultTable,
} from "@/lib/modules/bas/analyze/types";
import {
  askQuestion,
  cellText,
  describeGaps,
  describeRowCount,
  describeScope,
  describeSource,
  describeSourceRows,
  describeTimeRange,
  describeUnclassified,
  describeUnknownHorizon,
  fetchAnalyzeStatus,
  gapsTone,
  isAbortError,
  rateLimitMessage,
  resultHeading,
  resultTone,
  type AnalyzeStatus,
} from "./analyze-client";
import { databaseQueried } from "@/lib/modules/bas/analyze/types";
import { ApiError, formatTimestamp } from "./health-client";
import { TONE_INK, TONE_STYLE } from "./tone";

/**
 * Analyze - a question box over the sensor data (B5).
 *
 * The design rule is the one docs/BAS-B5.md opens with: a wrong or partial
 * answer must LOOK DIFFERENT from a right one. So the result is rendered from
 * its `kind`, not from an `answer` string with decorations, and the provenance
 * panel - what was queried, how many rows, which points, how many hours of the
 * period nobody was watching - is not collapsible and not optional.
 *
 * The SQL of a SUCCESSFUL answer is not rendered, by decision on 2026-09-21.
 * It is in the `bas.question_asked` audit row and the `bas.analyze.question`
 * log line, and stays in the API payload for both; the screen shows what was
 * queried in words - points, period, gaps, coverage, rows. A FAILED answer
 * does show each SQL that was tried, beside the reason it failed: there,
 * what was tried is the diagnosis rather than noise.
 *
 * There is no confidence score, on purpose. There is no chart, on purpose: a
 * question that wants a picture is answered with a link to the Point Explorer.
 *
 * THE SCREEN IS A THREAD (2026-10-09). Each question and what came back is a
 * turn, in the order asked, newest at the bottom, with the ask box under
 * them; a new question appends and earlier turns stay as they were. The
 * thread lasts a calendar day in the company's zone and survives a reload
 * of the same tab within it - and no longer than the tab (sessionStorage,
 * 2026-10-12) - see analyze-thread.ts for the rules and the reasons. Every turn is rendered by the same `Result` as before; an
 * older turn folds its rows table behind the one line it already carried,
 * and nothing else about a result changes with its position.
 *
 * A FOLLOW-UP CARRIES THE EARLIER TURNS (2026-10-09, step 2). The request
 * for a question sends `priorTurnsFor(turns)` - the newest turns that fit
 * the caps, cut down to question, interpretation, SQL, answer and a sample
 * of rows (analyze-thread.ts) - and nothing when the thread is empty. The
 * server is stateless about it: the thread is the browser's, and what it
 * sends is checked and capped like any other body. A follow-up the model
 * answers from an earlier turn's rows comes back as `from_prior`, rendered
 * with the no-query label AND a panel naming the question it read from.
 *
 * IT READS LIKE A MESSAGING APP (2026-10-12), and that is the whole of that
 * change: a question is a bubble on the right, what came back is plain text
 * on the left, the evidence is an inset block under it, and the ask box is
 * one rounded bar at the bottom. Every word, every figure, the folding, the
 * day's storage and what a request carries are exactly as above. See
 * `Result` for how a wrong answer still looks different from a right one.
 *
 * IN THE BRAND COLOURS (later the same day; docs/design/analyze-chat-mockup.png
 * is the chosen mock). Everything under the tab bar sits in ONE purple panel;
 * a question is a gold bubble; the answer and the evidence are cards tinted
 * from the panel's purple; blue carries what is pressable or navigational -
 * the evidence label, the rows expand link, the New conversation chip and
 * the Ask button, which is now a diamond echoing the mark. Every colour is
 * a token from app/globals.css, and the three ink values that only just
 * clear AA on the page ground are deepened on the tinted cards by the
 * `.analyze-panel` rule there, in place, so tone.ts is untouched. Maroon
 * appears only where it always has: a failed request and the config error.
 */

const EXAMPLES = [
  "What was the average room temperature last week?",
  "Which points have had no reading in the last 24 hours?",
  "How many hours of data gaps were recorded this month, by point?",
  "When did the collector last run, and did it succeed?",
];

export function Analyze({
  employeeId,
  now = () => new Date(),
}: {
  employeeId: string;
  /** Test seam: the clock the day boundary is read from. */
  now?: () => Date;
}) {
  const [status, setStatus] = useState<AnalyzeStatus | null>(null);
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<AnalyzeTurn[]>([]);
  const [pending, setPending] = useState<{ id: string; question: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The day the thread on screen belongs to. Null until read from storage. */
  const [day, setDay] = useState<string | null>(null);
  const inFlight = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchAnalyzeStatus(controller.signal)
      .then(setStatus)
      .catch((err: unknown) => {
        if (isAbortError(err)) return;
        setStatus({ configured: false, missing: [] });
        setError(err instanceof ApiError ? err.message : "Could not check the configuration.");
      });
    return () => controller.abort();
  }, []);

  /**
   * Today's thread, read after mount so the server-rendered page and the
   * first client render agree (reading storage during render is a
   * hydration mismatch). Any other day's thread for this employee is
   * discarded by the read itself.
   */
  useEffect(() => {
    const today = threadDay(now());
    setTurns(loadThread(browserStorage(), employeeId, today));
    setDay(today);
    // What the thread's earlier home left behind; nothing reads it now.
    forgetLocalThreads(legacyLocalStorage());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `now` is a test seam, not a dependency
  }, [employeeId]);

  // Every change to the thread is written back, once the thread has been
  // read. An empty thread is no key at all, not an empty record.
  useEffect(() => {
    if (day === null) return;
    if (turns.length === 0) clearThread(browserStorage(), employeeId, day);
    else saveThread(browserStorage(), employeeId, day, turns);
  }, [turns, day, employeeId]);

  // The newest turn - or the pending question - is brought into view.
  useEffect(() => {
    const el = endRef.current;
    if (el !== null && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "end", behavior: "smooth" });
    }
  }, [turns.length, pending]);

  const busy = pending !== null;

  /**
   * Append a resolved turn. If the day has rolled over since the thread was
   * read - a question asked at 11:59 PM and answered at 12:01 AM - the new
   * turn starts the new day's thread rather than being filed under
   * yesterday's and discarded on the next load.
   */
  function append(turn: AnalyzeTurn): void {
    const today = threadDay(now());
    if (today !== day) {
      setDay(today);
      setTurns([turn]);
    } else {
      setTurns((prev) => [...prev, turn]);
    }
  }

  async function submit(text: string) {
    const trimmed = text.trim();
    if (trimmed.length < 3 || busy) return;

    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;

    const id = newTurnId();
    const askedAt = now().toISOString();
    setPending({ id, question: trimmed });
    setQuestion("");

    try {
      const result = await askQuestion(trimmed, controller.signal, priorTurnsFor(turns));
      append({ id, askedAt, question: trimmed, outcome: { kind: "result", result } });
    } catch (err) {
      if (isAbortError(err)) return;
      const message =
        err instanceof ApiError
          ? err.code === "rate_limited"
            ? rateLimitMessage()
            : err.message
          : "Something went wrong. Try again.";
      append({ id, askedAt, question: trimmed, outcome: { kind: "error", message } });
    } finally {
      if (inFlight.current === controller) {
        inFlight.current = null;
        setPending(null);
      }
    }
  }

  function startFresh(): void {
    inFlight.current?.abort();
    inFlight.current = null;
    setPending(null);
    setTurns([]);
    if (day !== null) clearThread(browserStorage(), employeeId, day);
  }

  const notConfigured = status !== null && !status.configured;
  const empty = turns.length === 0 && pending === null;

  return (
    /*
      The one coloured area on the page: a purple panel holding the thread
      and the ask bar, content-width, with the bar kept at its foot. Nothing
      outside it - header, intro, tabs, ground - changes.
    */
    <div className="analyze-panel mx-auto flex w-full max-w-[75rem] min-h-[70vh] flex-col gap-6 rounded-[36px] bg-[var(--phb-purple)] p-4 shadow-[var(--shadow-soft)] sm:w-[94%] sm:p-7">
      {error !== null && (
        <section className="rounded-[24px] bg-[var(--phb-purple-tint)] px-5 py-4" role="alert">
          <p className="text-sm" style={{ color: TONE_INK.bad }}>
            {error}
          </p>
        </section>
      )}

      {/* ------------------------------------------------------ the thread */}
      {!empty && (
        <ol className="space-y-8" aria-label="Conversation" data-testid="bas-analyze-thread">
          {turns.map((turn, index) => (
            <li key={turn.id} data-testid="bas-analyze-turn">
              {turn.outcome.kind === "result" ? (
                <Result
                  result={turn.outcome.result}
                  asked={turn.question}
                  // Only the newest turn shows its rows unfolded.
                  compact={index < turns.length - 1}
                  sourceOrdinal={
                    turn.outcome.result.kind === "from_prior"
                      ? ordinalOf(turns, turn.outcome.result.source.id)
                      : null
                  }
                />
              ) : (
                <ErrorTurn asked={turn.question} message={turn.outcome.message} />
              )}
            </li>
          ))}
          {pending !== null && (
            <li data-testid="bas-analyze-pending">
              <PendingTurn asked={pending.question} />
            </li>
          )}
        </ol>
      )}
      <div ref={endRef} />

      {/* The examples sit where the thread will be, centred in the empty
          panel above the bar, so the bar itself is only ever the field and
          its button. Only the empty panel is laid out this way: once a
          conversation starts the thread flows from the top as before. */}
      {!notConfigured && empty && !error && (
        <div className="flex flex-1 flex-col items-center justify-center text-center">
          <p className="text-xs text-[var(--chrome-muted)]">Things people ask:</p>
          <ul className="mt-1.5 flex flex-wrap justify-center gap-2">
            {EXAMPLES.map((example) => (
              <li key={example}>
                <button
                  type="button"
                  onClick={() => {
                    setQuestion(example);
                    void submit(example);
                  }}
                  className="rounded-full bg-[var(--phb-purple-tint)] px-3 py-1 text-xs hover:bg-[var(--neutral-0)]"
                >
                  {example}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ----------------------------------------------------- the ask bar */}
      <section className="sticky bottom-4 z-10 mt-auto">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit(question);
          }}
          className="flex items-center gap-3"
        >
          {/* The label is for assistive technology; on screen the field's
              own placeholder and the thread above it say what it is for. */}
          <label htmlFor="bas-analyze-question" className="sr-only">
            Ask a question
          </label>
          {/* One opaque capsule holds the field, the hint and New
              conversation, so nothing in the thread scrolls up behind any
              of them while the bar is stuck to the bottom. The Ask diamond
              sits beside it, on the panel. */}
          <div className="min-w-0 flex-1 rounded-[28px] bg-white px-5 pb-3 pt-2.5 shadow-[var(--shadow-soft)] transition-shadow focus-within:ring-2 focus-within:ring-[var(--module-accent,var(--phb-cyan))]">
            <div className="flex items-end gap-2">
              <textarea
                id="bas-analyze-question"
                name="question"
                rows={2}
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void submit(question);
                  }
                }}
                disabled={notConfigured || busy}
                placeholder="What was the average room temperature last week?"
                maxLength={1000}
                className="min-w-0 flex-1 resize-none bg-transparent py-2 text-sm leading-relaxed placeholder:text-[var(--neutral-500)] focus:outline-none disabled:cursor-not-allowed disabled:text-[var(--muted)]"
              />
            </div>
            <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-[var(--muted)]">
                Enter asks · Shift+Enter for a new line
              </p>
              {!empty && (
                <button
                  type="button"
                  onClick={startFresh}
                  data-testid="bas-analyze-new-conversation"
                  className="rounded-full bg-[var(--phb-cyan-tint)] px-3 py-1 text-[0.75rem] font-medium text-[var(--phb-cyan-ink)] hover:bg-[var(--neutral-0)]"
                >
                  New conversation
                </button>
              )}
            </div>
          </div>
          {/* The Ask diamond: the mark's shape, in the module's blue. The
              button is the 72px square (the hit area); the rotated square
              inside it is the picture, and the word stays upright because
              only the picture is rotated. Same disabled and working rules as
              before - the word changes, the shape does not. */}
          <button
            type="submit"
            disabled={notConfigured || busy || question.trim().length < 3}
            className="relative flex h-[4.5rem] w-[4.5rem] shrink-0 items-center justify-center rounded-[16px] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span
              aria-hidden="true"
              className="absolute h-[52px] w-[52px] rotate-45 rounded-[16px] bg-[var(--phb-cyan-ink)] shadow-[var(--shadow-soft)]"
            />
            <span
              className={
                "relative font-display font-semibold text-white " +
                (busy ? "text-[0.625rem]" : "text-sm")
              }
            >
              {busy ? "Working…" : "Ask"}
            </span>
          </button>
        </form>

        {status === null && !error && (
          <p className="mt-3 px-1 text-xs text-[var(--chrome-muted)]">Checking configuration…</p>
        )}

        {notConfigured && (
          <NotConfigured missing={status.missing} />
        )}
      </section>
    </div>
  );
}

/**
 * The question, as the person's own bubble: right-aligned and sized to its
 * text, which is what says who is speaking. The words "You asked" are kept
 * for a screen reader, which cannot see the alignment.
 */
function QuestionBubble({ children }: { children: string }) {
  return (
    <div className="flex justify-end">
      <span className="sr-only">You asked</span>
      <p
        data-testid="bas-analyze-question"
        className="max-w-[min(85%,40rem)] whitespace-pre-wrap break-words rounded-[24px] rounded-br-[8px] bg-[var(--phb-gold)] px-4 py-2.5 text-sm font-medium leading-relaxed text-[var(--foreground)]"
      >
        {children}
      </p>
    </div>
  );
}

/** Where a turn sits in today's thread, 1-based, or null when it is no longer there. */
function ordinalOf(turns: AnalyzeTurn[], id: string): number | null {
  const index = turns.findIndex((turn) => turn.id === id);
  return index === -1 ? null : index + 1;
}

/** A question the server has not answered yet. The indicator is the button's own word. */
function PendingTurn({ asked }: { asked: string }) {
  return (
    <>
      <QuestionBubble>{asked}</QuestionBubble>
      <div className="mt-3" aria-live="polite" aria-busy="true">
        <p className="animate-pulse text-sm text-[var(--chrome-muted)]">Working…</p>
      </div>
    </>
  );
}

/** A question the request itself failed on: no result to render, the message as before. */
function ErrorTurn({ asked, message }: { asked: string; message: string }) {
  return (
    <>
      <QuestionBubble>{asked}</QuestionBubble>
      <p
        className="mt-3 rounded-[24px] bg-[var(--phb-purple-tint)] px-5 py-4 text-sm leading-relaxed"
        role="alert"
        style={{ color: TONE_INK.bad }}
      >
        {message}
      </p>
    </>
  );
}

function NotConfigured({ missing }: { missing: string[] }) {
  return (
    <div className="mt-4 rounded-md border p-4" style={TONE_STYLE.neutral}>
      <p className="text-sm font-medium">Analyze is not configured on this server.</p>
      <p className="mt-1 text-xs text-[var(--muted)]">
        The rest of Building Automation is unaffected.{" "}
        {missing.length > 0 ? (
          <>
            Missing: <code className="text-[0.75rem]">{missing.join(", ")}</code>. See
            runbook.md, <em>Analyze says it is not configured</em>.
          </>
        ) : (
          <>The configuration check itself failed. See runbook.md.</>
        )}
      </p>
    </div>
  );
}

/**
 * Exported for tests/bas-analyze-ui.test.tsx, which renders a `no_data` result
 * and an `answered` result whose value is 0 and asserts the markup differs.
 */
export function Result({
  result,
  asked,
  compact = false,
  sourceOrdinal = null,
}: {
  result: AnalyzeResult;
  asked: string;
  /**
   * An older turn in the thread: the rows table is folded behind its own
   * one-line label. Nothing else changes - the answer, the provenance
   * panel and every warning render exactly as on the newest.
   */
  compact?: boolean;
  /** For a from-memory answer: where its source turn sits in the thread, if it still does. */
  sourceOrdinal?: number | null;
}) {
  const tone = resultTone(result);

  /*
    THE CHAT LOOK (2026-10-12). The question is a bubble on the right; what
    came back is plain text on the left, on the page itself, with no card
    around it. The heading a result carries is still rendered from its kind
    - "No data matched", "Could not answer", "One question first", "Answer,
    read from an earlier result" - in its tone's ink, because that heading is
    how a wrong or partial answer looks different from a right one. The one
    heading that says nothing the alignment does not, "Answer", is kept for
    a screen reader and hidden from sight: the answer's own first sentence
    is the headline.

    Below the headline, everything that is evidence rather than answer - the
    provenance panel, the rows, the no-query label - is one inset block,
    quieter than the answer. The footnote, not the headline.

    THREE LINES OF META TEXT WERE REMOVED ON 2026-10-12, by decision: the
    plan's interpretation ("How the question was read"), the caveat that the
    paragraph is the model's reading of the rows and the rows win where they
    disagree, and the note that a first attempt was retried. Nothing was
    relocated: the answer paragraph is followed directly by "What was
    actually queried". The interpretation and `retried` are still in the
    payload and the audit row; the screen no longer shows them.
  */
  const plainAnswer = result.kind === "answered";

  return (
    <>
      <QuestionBubble>{asked}</QuestionBubble>
      <section className="mt-3" aria-live="polite">
        {/* The answer card: the heading (where one is shown) and the one
            paragraph that is the answer. Everything else is the evidence
            card below it. */}
        <div className="rounded-[24px] bg-[var(--phb-purple-tint)] px-5 py-4">
          <h2
            className={
              plainAnswer
                ? "sr-only"
                : "font-display text-[0.8125rem] font-semibold uppercase tracking-[0.07em]"
            }
            style={plainAnswer ? undefined : { color: TONE_INK[tone] }}
          >
            {resultHeading(result)}
          </h2>
          {result.kind === "not_configured" && <NotConfigured missing={result.missing} />}
          {result.kind === "clarify" && (
            <p className="mt-2 text-[0.9375rem] leading-relaxed">{result.question}</p>
          )}
          {result.kind === "cannot_answer" && (
            <p className="mt-2 text-[0.9375rem] leading-relaxed">{result.reason}</p>
          )}
          {result.kind === "no_data" && (
            <p className="mt-2 text-[0.9375rem] leading-relaxed" style={{ color: TONE_INK.warn }}>
              {result.explanation}
            </p>
          )}
          {result.kind === "from_prior" && (
            <p className="mt-2 text-[0.9375rem] leading-relaxed">{result.answer}</p>
          )}
          {result.kind === "answered" && (
            <p className="text-[0.9375rem] leading-relaxed">{result.answer}</p>
          )}
        </div>

        {result.kind === "not_configured" && (
          <Footnote>
            <NoQueryLabel result={result} />
          </Footnote>
        )}

        {result.kind === "clarify" && (
          <>
            <Footnote>
              <p className="text-xs text-[var(--muted)]">Ask again with the detail filled in.</p>
              <NoQueryLabel result={result} />
            </Footnote>
          </>
        )}

        {result.kind === "cannot_answer" && (
          <>
            <Footnote>
              {result.attempts.length > 0 && (
                <div>
                  <p className="text-xs font-medium">
                    {result.attempts.length === 1 ? "What was tried" : "What was tried, in order"}
                  </p>
                  <ol className="mt-1.5 space-y-2">
                    {result.attempts.map((attempt, i) => (
                      <li key={i} className="rounded-[var(--radius-row)] border border-[var(--phb-purple-tint-line)] p-3">
                        {/* A failed answer is the one place the SQL earns its
                            space: what was tried is the diagnosis. A successful
                            answer's SQL is recorded, not rendered (see the file
                            header). */}
                        {attempt.sql.length > 0 && (
                          <pre className="overflow-x-auto rounded-md border border-[var(--border)] bg-[var(--neutral-50,var(--surface))] p-3 text-[0.75rem] leading-relaxed">
                            <code>{attempt.sql}</code>
                          </pre>
                        )}
                        <p className="mt-1.5 text-xs" style={{ color: TONE_INK.warn }}>
                          {attempt.error}
                        </p>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
              <NoQueryLabel result={result} />
            </Footnote>
          </>
        )}

        {result.kind === "no_data" && (
          <>
            <Footnote>
              <ProvenancePanel provenance={result.provenance} table={result.table} durationMs={result.durationMs} />
              {/* Always rendered: zero rows gets its own sentence, an all-NULL
                  row is shown AS the NULL row, so what the database returned is
                  never left to be inferred from an absence. */}
              <RowsTable table={result.table} nullOnly={result.reason === "all_null"} folded={compact} />
            </Footnote>
          </>
        )}

        {result.kind === "from_prior" && (
          <>
            <Footnote>
              <SourcePanel source={result.source} ordinal={sourceOrdinal} />
              <NoQueryLabel result={result} />
            </Footnote>
          </>
        )}

        {result.kind === "answered" && (
          <>
            <Footnote>
              <ProvenancePanel provenance={result.provenance} table={result.table} durationMs={result.durationMs} />
              <RowsTable table={result.table} folded={compact} />
            </Footnote>
          </>
        )}

      </section>
    </>
  );
}

/**
 * The evidence under an answer: its own tinted card, inset from the left
 * and smaller than the sentence above it. One block, so every result's
 * evidence is set the same way.
 */
function Footnote({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-3 ml-4 space-y-4 rounded-[24px] bg-[var(--phb-purple-tint)] px-5 py-4">
      {children}
    </div>
  );
}

/**
 * The single most important thing a skeptical reader can learn about a
 * result that is not an answer: whether the database was consulted at
 * all. Decided by `databaseQueried` - the same function the audit row
 * records `queried` from - so a guard refusal, which shows an SQL
 * beside an error and looks like a failed query, is still labelled as
 * no query. Never rendered on a result whose SQL ran.
 */
function NoQueryLabel({ result }: { result: AnalyzeResult }) {
  if (databaseQueried(result)) return null;
  return (
    <p className="text-xs font-medium" data-testid="bas-analyze-no-query">
      No database query was run for this answer.
    </p>
  );
}

/**
 * The provenance panel of a from-memory answer: the same heading as every
 * other result's, because the question it answers is the same - what was
 * actually queried - and the answer here is "nothing new, and here is what
 * it was read from instead". Always rendered, never collapsible.
 */
function SourcePanel({
  source,
  ordinal,
}: {
  source: Extract<AnalyzeResult, { kind: "from_prior" }>["source"];
  ordinal: number | null;
}) {
  const rows = describeSourceRows(source);
  return (
    <div data-testid="bas-analyze-source">
      <PanelHeading />
      <dl className="divide-y divide-[var(--phb-purple-tint-line)]">
        <Row label="Read from">{describeSource(source, ordinal)}</Row>
        <Row label="Rows" tone={rows.tone}>
          {rows.text}
        </Row>
      </dl>
    </div>
  );
}

/**
 * Always rendered, never collapsible. Gaps first, because docs/BAS-B5.md says
 * that is the one that matters most.
 */
function ProvenancePanel({
  provenance,
  table,
  durationMs,
}: {
  provenance: Provenance;
  table: ResultTable;
  durationMs: number;
}) {
  const gTone = gapsTone(provenance);
  const horizon = describeUnknownHorizon(provenance);
  const unclassified = describeUnclassified(provenance);

  return (
    <div>
      <PanelHeading />

      <dl className="divide-y divide-[var(--phb-purple-tint-line)]">
        <Row label="Gaps in the period" tone={gTone}>
          {describeGaps(provenance)}
          {provenance.gaps !== null && provenance.gaps.items.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs">
              {provenance.gaps.items.slice(0, 12).map((gap) => (
                <li key={`${gap.pointId}-${gap.start}`} className="tabular-nums">
                  {gap.pointName}: {formatTimestamp(gap.start)} – {formatTimestamp(gap.end)}{" "}
                  ({gap.hours % 1 === 0 ? gap.hours : gap.hours.toFixed(1)} h, {gap.cause.replace(/_/g, " ")})
                </li>
              ))}
              {provenance.gaps.items.length > 12 && (
                <li className="text-[var(--muted)]">
                  and {provenance.gaps.items.length - 12} more
                </li>
              )}
            </ul>
          )}
        </Row>

        {provenance.coverageShortfall !== null && (
          <Row label="Coverage" tone="warn">
            {provenance.coverageShortfall}
          </Row>
        )}

        {horizon.length > 0 && (
          <Row label="Roll horizon" tone="warn">
            {horizon}
          </Row>
        )}

        <Row label="Time range" tone={provenance.periodUndeclared ? "warn" : "neutral"}>
          {describeTimeRange(
            provenance.timeRange,
            (iso) => formatTimestamp(iso),
            provenance.periodUndeclared,
          )}
        </Row>

        <Row label="Points and sites">
          {describeScope(provenance)}
          {provenance.points.length > 0 && provenance.scope === "declared" && (
            <ul className="mt-1.5 flex flex-wrap gap-1.5">
              {provenance.points.map((p) => (
                <li
                  key={p.id}
                  className="rounded-full border border-[var(--border)] px-2 py-0.5 text-xs"
                  title={`${p.site} · ${p.station}`}
                >
                  {p.name}
                  <span className="text-[var(--muted)]"> · {p.site}</span>
                  {!p.collected && <span style={{ color: TONE_INK.warn }}> · not collected</span>}
                </li>
              ))}
            </ul>
          )}
          {provenance.coverage !== null && (
            <p className="mt-1.5 text-xs text-[var(--muted)]">
              Readings held for these points:{" "}
              {provenance.coverage.readings === 0
                ? "none"
                : `${provenance.coverage.readings.toLocaleString()} from ${formatTimestamp(provenance.coverage.earliest)} to ${formatTimestamp(provenance.coverage.latest)}`}
              {provenance.coverage.neverCollected.length > 0 && (
                <>
                  . Never collected: {provenance.coverage.neverCollected.join(", ")}
                </>
              )}
            </p>
          )}
          {unclassified.length > 0 && (
            <p className="mt-1.5 text-xs" style={{ color: TONE_INK.warn }}>
              {unclassified}
            </p>
          )}
        </Row>

        <Row label="Rows">
          {describeRowCount(table)}
          <span className="text-[var(--muted)]"> · {(durationMs / 1000).toFixed(1)} s</span>
        </Row>
      </dl>
    </div>
  );
}

/** The one heading both evidence panels carry, set as the footnote's eyebrow. */
function PanelHeading() {
  return (
    <p className="font-display text-[0.6875rem] font-semibold uppercase tracking-[0.07em] text-[var(--phb-cyan-ink)]">
      What was actually queried
    </p>
  );
}

function Row({
  label,
  tone = "neutral",
  children,
}: {
  label: string;
  tone?: "ok" | "warn" | "bad" | "neutral";
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 gap-1 py-2.5 sm:grid-cols-[9rem_1fr] sm:gap-4">
      <dt className="text-xs font-medium text-[var(--muted)]">{label}</dt>
      <dd className="text-[0.8125rem] leading-relaxed" style={tone === "neutral" ? undefined : { color: TONE_INK[tone] }}>
        {children}
      </dd>
    </div>
  );
}

function RowsTable({
  table,
  nullOnly = false,
  folded = false,
}: {
  table: ResultTable;
  nullOnly?: boolean;
  /** Older turns: the table sits behind its label, a click away. */
  folded?: boolean;
}) {
  if (table.rowCount === 0) {
    return (
      <p className="text-xs text-[var(--muted)]">
        Zero rows. There is no table to show, and that is the finding.
      </p>
    );
  }

  const label = nullOnly
    ? "The row the database returned - every cell is NULL"
    : `Rows the database returned (${table.rowCount})`;

  // A native <details>: the same line is the summary when folded, so the
  // count stays on screen and the rows are one click away, with no state
  // and no new words. The newest turn is a plain block, open as it always was.
  const Wrapper = folded ? "details" : "div";
  const Label = folded ? "summary" : "p";

  return (
    <Wrapper data-testid="bas-analyze-rows" data-folded={folded ? "true" : "false"}>
      <Label
        className={
          "text-xs font-medium" + (folded ? " cursor-pointer text-[var(--phb-cyan-ink)]" : "")
        }
      >
        {label}
      </Label>
      {/* The module's one scroll pattern: up to 200 rows, sticky header, count above. */}
      <div className="mt-1.5 max-h-72 overflow-auto rounded-md border border-[var(--phb-purple-tint-line)]">
        <table className="w-full text-xs">
          <thead className="sticky top-0 z-10 bg-[var(--surface)] text-left">
            <tr className="border-b border-[var(--phb-purple-tint-line)] text-left">
              {table.columns.map((column, i) => (
                <th key={`${column}-${i}`} className="px-3 py-2 font-medium">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, r) => (
              <tr key={r} className="border-b border-[var(--phb-purple-tint-line)] last:border-b-0">
                {row.map((cell, c) => (
                  <td
                    key={c}
                    className={
                      "px-3 py-1.5 tabular-nums " +
                      (cell === null ? "italic text-[var(--muted)]" : "")
                    }
                  >
                    {cellText(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {table.truncated && (
        <p className="mt-1.5 text-xs" style={{ color: TONE_INK.warn }}>
          Capped at {table.rowCap} rows. The query matched more; narrow it or aggregate.
        </p>
      )}
    </Wrapper>
  );
}
