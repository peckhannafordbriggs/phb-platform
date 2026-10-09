"use client";

import { useEffect, useRef, useState } from "react";
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
 * There is no history across sessions; the last result stays on screen until
 * the next question replaces it.
 */

const EXAMPLES = [
  "What was the average room temperature last week?",
  "Which points have had no reading in the last 24 hours?",
  "How many hours of data gaps were recorded this month, by point?",
  "When did the collector last run, and did it succeed?",
];

export function Analyze() {
  const [status, setStatus] = useState<AnalyzeStatus | null>(null);
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState<string | null>(null);
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef<AbortController | null>(null);

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

  async function submit(text: string) {
    const trimmed = text.trim();
    if (trimmed.length < 3 || busy) return;

    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;

    setBusy(true);
    setError(null);
    setAsked(trimmed);
    setResult(null);

    try {
      const answer = await askQuestion(trimmed, controller.signal);
      setResult(answer);
    } catch (err) {
      if (isAbortError(err)) return;
      if (err instanceof ApiError) {
        setError(err.code === "rate_limited" ? rateLimitMessage() : err.message);
      } else {
        setError("Something went wrong. Try again.");
      }
    } finally {
      if (inFlight.current === controller) {
        inFlight.current = null;
        setBusy(false);
      }
    }
  }

  const notConfigured = status !== null && !status.configured;

  return (
    <div className="space-y-6">
      <section className="card p-5">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit(question);
          }}
        >
          <label
            htmlFor="bas-analyze-question"
            className="font-display text-[0.8125rem] font-semibold uppercase tracking-[0.07em]"
          >
            Ask a question
          </label>
          <textarea
            id="bas-analyze-question"
            name="question"
            rows={3}
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
            className="mt-2 w-full resize-y rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-[var(--module-accent,var(--phb-cyan))]"
          />
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={notConfigured || busy || question.trim().length < 3}
              className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-medium hover:bg-[var(--neutral-100)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Working…" : "Ask"}
            </button>
            <p className="text-xs text-[var(--muted)]">
              Enter asks · Shift+Enter for a new line
            </p>
          </div>
        </form>

        {status === null && !error && (
          <p className="mt-3 text-xs text-[var(--muted)]">Checking configuration…</p>
        )}

        {notConfigured && (
          <NotConfigured missing={status.missing} />
        )}

        {!notConfigured && result === null && !busy && !error && (
          <div className="mt-4">
            <p className="text-xs text-[var(--muted)]">Things people ask:</p>
            <ul className="mt-1.5 flex flex-wrap gap-2">
              {EXAMPLES.map((example) => (
                <li key={example}>
                  <button
                    type="button"
                    onClick={() => {
                      setQuestion(example);
                      void submit(example);
                    }}
                    className="rounded-full border border-[var(--border)] px-3 py-1 text-xs hover:bg-[var(--neutral-100)]"
                  >
                    {example}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {error !== null && (
        <section className="card p-5" role="alert" style={TONE_STYLE.bad}>
          <p className="text-sm" style={{ color: TONE_INK.bad }}>
            {error}
          </p>
        </section>
      )}

      {busy && (
        <section className="card p-5" aria-live="polite">
          <p className="text-sm text-[var(--muted)]">
            Working on “{asked}”. Usually under half a minute.
          </p>
        </section>
      )}

      {result !== null && asked !== null && (
        <Result result={result} asked={asked} />
      )}
    </div>
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
export function Result({ result, asked }: { result: AnalyzeResult; asked: string }) {
  const tone = resultTone(result);

  return (
    <section className="card overflow-hidden" aria-live="polite">
      <header className="border-b px-5 pb-3 pt-4" style={{ ...TONE_STYLE[tone], borderBottomWidth: 1 }}>
        <p className="text-xs text-[var(--muted)]">You asked</p>
        <p className="mt-0.5 text-sm">{asked}</p>
        <h2
          className="mt-3 font-display text-[0.8125rem] font-semibold uppercase tracking-[0.07em]"
          style={{ color: TONE_INK[tone] }}
        >
          {resultHeading(result)}
        </h2>
        {"retried" in result && result.retried && (
          <p className="mt-1 text-xs text-[var(--muted)]">
            The first query attempt was not usable and a second was requested. What was tried is shown below.
          </p>
        )}
      </header>

      <div className="space-y-5 px-5 py-4">
        {result.kind === "not_configured" && <NotConfigured missing={result.missing} />}

        {result.kind === "clarify" && (
          <>
            <p className="text-sm leading-relaxed">{result.question}</p>
            <p className="text-xs text-[var(--muted)]">
              How the question was read: {result.interpretation}
            </p>
            <p className="text-xs text-[var(--muted)]">Ask again with the detail filled in.</p>
          </>
        )}

        {result.kind === "cannot_answer" && (
          <>
            <p className="text-sm leading-relaxed">{result.reason}</p>
            {result.attempts.length > 0 && (
              <div>
                <p className="text-xs font-medium">
                  {result.attempts.length === 1 ? "What was tried" : "What was tried, in order"}
                </p>
                <ol className="mt-1.5 space-y-2">
                  {result.attempts.map((attempt, i) => (
                    <li key={i} className="rounded-md border border-[var(--border)] p-3">
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
          </>
        )}

        {result.kind === "no_data" && (
          <>
            <p className="text-sm leading-relaxed" style={{ color: TONE_INK.warn }}>
              {result.explanation}
            </p>
            <p className="text-xs text-[var(--muted)]">
              How the question was read: {result.interpretation}
            </p>
            <ProvenancePanel provenance={result.provenance} table={result.table} durationMs={result.durationMs} />
            {/* Always rendered: zero rows gets its own sentence, an all-NULL
                row is shown AS the NULL row, so what the database returned is
                never left to be inferred from an absence. */}
            <RowsTable table={result.table} nullOnly={result.reason === "all_null"} />
          </>
        )}

        {result.kind === "answered" && (
          <>
            <div>
              <p className="text-sm leading-relaxed">{result.answer}</p>
              {/* Stays: it stops a number in the prose being trusted over the rows. */}
              <p className="mt-1.5 text-xs text-[var(--muted)]">
                The paragraph above is the model&apos;s reading of the rows below; where
                they disagree, the rows are right.
              </p>
            </div>
            <p className="text-xs text-[var(--muted)]">
              How the question was read: {result.interpretation}
            </p>
            <ProvenancePanel provenance={result.provenance} table={result.table} durationMs={result.durationMs} />
            <RowsTable table={result.table} />
          </>
        )}

        {/*
          The single most important thing a skeptical reader can learn about a
          result that is not an answer: whether the database was consulted at
          all. Decided by `databaseQueried` - the same function the audit row
          records `queried` from - so a guard refusal, which shows an SQL
          beside an error and looks like a failed query, is still labelled as
          no query. Never rendered on a result whose SQL ran.
        */}
        {!databaseQueried(result) && (
          <p className="text-xs font-medium" data-testid="bas-analyze-no-query">
            No database query was run for this answer.
          </p>
        )}
      </div>
    </section>
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
    <div className="rounded-md border border-[var(--border)]">
      <div className="border-b border-[var(--border)] px-4 py-3">
        <p className="font-display text-[0.75rem] font-semibold uppercase tracking-[0.07em]">
          What was actually queried
        </p>
      </div>

      <dl className="divide-y divide-[var(--border)] text-sm">
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
    <div className="grid grid-cols-1 gap-1 px-4 py-3 sm:grid-cols-[10rem_1fr] sm:gap-4">
      <dt className="text-xs font-medium text-[var(--muted)]">{label}</dt>
      <dd className="text-sm leading-relaxed" style={tone === "neutral" ? undefined : { color: TONE_INK[tone] }}>
        {children}
      </dd>
    </div>
  );
}

function RowsTable({ table, nullOnly = false }: { table: ResultTable; nullOnly?: boolean }) {
  if (table.rowCount === 0) {
    return (
      <p className="text-xs text-[var(--muted)]">
        Zero rows. There is no table to show, and that is the finding.
      </p>
    );
  }

  return (
    <div>
      <p className="text-xs font-medium">
        {nullOnly
          ? "The row the database returned - every cell is NULL"
          : `Rows the database returned (${table.rowCount})`}
      </p>
      {/* The module's one scroll pattern: up to 200 rows, sticky header, count above. */}
      <div className="mt-1.5 max-h-72 overflow-auto rounded-md border border-[var(--border)]">
        <table className="w-full text-xs">
          <thead className="sticky top-0 z-10 bg-[var(--surface)] text-left">
            <tr className="border-b border-[var(--border)] text-left">
              {table.columns.map((column, i) => (
                <th key={`${column}-${i}`} className="px-3 py-2 font-medium">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, r) => (
              <tr key={r} className="border-b border-[var(--border)] last:border-b-0">
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
    </div>
  );
}
