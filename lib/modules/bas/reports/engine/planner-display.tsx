/** @jsxRuntime automatic @jsxImportSource react */
// The pragma for the same reason render.tsx carries it: this file is
// rendered by Next, by vitest and by the worker under tsx.
import type { PlannerAnswer } from "./types";

/**
 * How a planner answer is SHOWN (Reports, Phase 6; display revised twice on
 * 2026-11-16). Everything the planner produced stays stored on the run's
 * document exactly as before - the answer text whole, the interpretation,
 * every point name kept, the period, the gap figures, the SQL, the rows,
 * the cost. This file decides what of it a reader sees, and where:
 *
 *   the page and the PDF    the question and the planner's prose answer -
 *                           its paragraphs and its list, as written - less
 *                           its coverage paragraph (below). Two amber lines
 *                           are the only other things shown, both
 *                           render.tsx's: the note for a query that touched
 *                           another building or period, and the coverage
 *                           shortfall.
 *   the web run view only   `PlannerHowPanel` behind a kit Button, "Show
 *                           how this was answered": the coverage
 *                           paragraph, how the question was read, the
 *                           period and every point, the gap figures, the
 *                           results table, the SQL and the cost. The PDF never has it: the stored HTML is
 *                           rendered with no slot for it (html.ts), and
 *                           REPORT_CSS hides it under `@media print` for
 *                           the web page's own Print.
 *
 * THE COVERAGE PARAGRAPH is the summariser's own sentence about the period,
 * the missing hours, the unclassified points and the age of the data - "This
 * covers 22 September at 9:00 AM through 29 September … so these are not
 * current conditions." The answer is stored as one string, so it is split
 * here, at display time, by `splitPlannerAnswer`: a paragraph that is not
 * the first, is not a list item, and opens or reads the way the
 * summariser's coverage sentences do (COVERAGE_PATTERNS) moves to the
 * panel. The rule is conservative on purpose: a paragraph it does not
 * recognise stays on the page, so a miss shows a caveat the reader did not
 * need rather than hiding part of the answer.
 *
 * No React state and no engine imports here, so the client toggle
 * (app/(modules)/bas/reports-planner-how.tsx) can import the panel without
 * pulling the engine - or Prisma - into the browser bundle.
 */

export const SHOW_HOW_LABEL = "Show how this was answered";
export const HIDE_HOW_LABEL = "Hide";

type Cell = string | number | boolean | null;

/**
 * How the summariser's coverage paragraph reads (docs/11 puts the period,
 * the gaps and the age of the data after the answer). Measured against the
 * office's run 18: "This covers 22 September …" and "The newest reading held
 * for this station is from 29 September …, so this is historical data, not
 * a live view." Case-insensitive.
 */
export const COVERAGE_PATTERNS: readonly RegExp[] = [
  /^this (answer )?(covers|is based on|describes)\b/i,
  /^these (figures|numbers|counts|readings) (cover|describe)\b/i,
  /^(the )?(newest|latest|most recent) reading\b/i,
  /\bnot (the )?current conditions\b/i,
  /\bnot a live view\b/i,
];

/**
 * The answer as the page shows it, and the coverage paragraphs the panel
 * shows. Paragraphs are the summariser's lines; list items ("- ") always
 * stay with the answer, and so does the first paragraph, which is the
 * answer itself (docs/11: answer first).
 */
export function splitPlannerAnswer(text: string): { answer: string; coverage: string[] } {
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  const coverage: string[] = [];
  let seenParagraph = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) {
      kept.push(raw);
      continue;
    }
    const isList = line.startsWith("- ");
    if (!isList && seenParagraph && COVERAGE_PATTERNS.some((p) => p.test(line))) {
      coverage.push(line);
      continue;
    }
    if (!isList) seenParagraph = true;
    kept.push(raw);
  }
  return { answer: kept.join("\n").trim(), coverage };
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function dateIn(d: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, day: "numeric", month: "short", year: "numeric" }).format(d);
}

function timeIn(d: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
}

/**
 * A result cell as the panel prints it. An instant is a local date - with
 * the time when it is not local midnight - never an ISO string. An instant
 * at exactly midnight UTC is a calendar date: a PostgreSQL `date` the pool
 * read on a UTC host, or a day bucketed in the role's UTC session, and
 * reading it in a western zone would print the day before.
 */
export function formatPlannerCell(cell: Cell, timezone: string): string {
  if (cell === null) return "—";
  if (typeof cell === "boolean") return cell ? "true" : "false";
  if (typeof cell === "string") {
    if (ISO_DATE.test(cell)) return dateIn(new Date(`${cell}T00:00:00Z`), "UTC");
    if (ISO_INSTANT.test(cell)) {
      const d = new Date(cell);
      if (Number.isNaN(d.getTime())) return cell;
      if (cell.slice(11, 19) === "00:00:00" && /^(\.0+)?Z$/.test(cell.slice(19))) return dateIn(d, "UTC");
      const time = timeIn(d, timezone);
      return time === "00:00" ? dateIn(d, timezone) : `${dateIn(d, timezone)}, ${time}`;
    }
  }
  return String(cell);
}

/** Whether there is anything behind the button. */
export function hasPlannerDetails(a: PlannerAnswer): boolean {
  const coverage = a.answer === null ? [] : splitPlannerAnswer(a.answer).coverage;
  return coverage.length > 0 || a.interpretation !== null || a.sql !== null || a.provenance !== null || a.table !== null || a.calls > 0;
}

/**
 * Everything behind "Show how this was answered": the summariser's coverage
 * paragraph, how the planner read the question, the period it queried with
 * the gap figures (the coverage shortfall is on the page), every point name
 * kept on the run, the
 * results table (every row the run kept, dates local), the SQL and the
 * cost. The web run view only.
 */
export function PlannerHowPanel({ answer: a, timezone }: { answer: PlannerAnswer; timezone: string }) {
  const p = a.provenance;
  const coverage = a.answer === null ? [] : splitPlannerAnswer(a.answer).coverage;
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const table = a.outcome === "answered" && a.table !== null && a.table.rowCount > 0 ? a.table : null;
  return (
    <div className="planner-how-panel">
      {coverage.map((line, i) => (
        <p key={`c${i}`}>{line}</p>
      ))}
      {a.interpretation !== null && (
        <p>
          <strong>How the question was read:</strong> {a.interpretation}
        </p>
      )}
      {p !== null && (
        <p>
          <strong>Period queried:</strong>{" "}
          {p.timeRange !== null
            ? `${f.format(new Date(p.timeRange.start))} to ${f.format(new Date(p.timeRange.end))}`
            : p.periodUndeclared
              ? "not stated by the planner"
              : "none - the query reads no readings"}
          {p.gapHours !== null && p.gapHours > 0 ? ` · ${p.gapHours} hours of it unrecorded` : ""}
        </p>
      )}
      {p !== null && p.pointCount > 0 && (
        <p>
          <strong>
            {p.pointCount} point{p.pointCount === 1 ? "" : "s"}:
          </strong>{" "}
          {p.points.join(", ")}
          {p.pointCount > p.points.length ? ` and ${p.pointCount - p.points.length} more` : ""}
        </p>
      )}
      {p !== null && p.unclassifiedExcluded > 0 && <p>{p.unclassifiedExcluded} points with no role set were outside a search by role.</p>}
      {p !== null && p.unknownHorizonCount > 0 && <p>{p.unknownHorizonCount} of the points have an unknown roll horizon.</p>}
      {p !== null && p.neverCollected.length > 0 && <p>Never collected: {p.neverCollected.join(", ")}.</p>}
      {table !== null && (
        <div className="planner-how-table">
          <table>
            <thead>
              <tr>
                {table.columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j}>{formatPlannerCell(cell, timezone)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {(table.kept < table.rowCount || table.truncated) && (
            <p className="planner-meta">
              {table.kept} of {table.rowCount.toLocaleString("en-US")}
              {table.truncated ? "+" : ""} rows kept on the run.
            </p>
          )}
        </div>
      )}
      {a.sql !== null && <pre className="sql">{a.sql}</pre>}
      <p className="planner-meta">
        {a.calls === 0 ? "No model call was made." : `${a.calls} model call${a.calls === 1 ? "" : "s"} · $${a.costUsd.toFixed(4)}`}
        {a.durationMs > 0 ? ` · ${Math.round(a.durationMs / 100) / 10} s` : ""}
        {a.retried ? " · the first plan was unusable and a second was asked for" : ""}
      </p>
    </div>
  );
}
