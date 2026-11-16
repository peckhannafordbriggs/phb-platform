/** @jsxRuntime automatic @jsxImportSource react */
// The pragma for the same reason render.tsx carries it: this file is
// rendered by Next, by vitest and by the worker under tsx.
import type { OccupancyKind, PlannerAnswer } from "./types";

/**
 * How a planner answer is SHOWN (Reports, Phase 6, display revised
 * 2026-11-16). Everything the planner produced stays stored on the run's
 * document exactly as before - the interpretation, every point name kept,
 * the period, the gap figures, the SQL, the rows, the cost. This file
 * decides what of it a reader sees, and where:
 *
 *   the page and the PDF    the question, the answer in prose, a results
 *                           table when it is small (at most 12 rows and 6
 *                           columns, else the first 12 rows and the first
 *                           6 columns, and a line saying how much is
 *                           shown), dates as local dates, and ONE grey line:
 *                           "Read N points on <station> for <period>;
 *                           occupied hours from <source>." The amber notes
 *                           - a point on another building, another period,
 *                           readings that do not cover the period - are
 *                           render.tsx's and stay on both.
 *   the web run view only   `PlannerHowPanel` behind a kit Button, "Show
 *                           how this was answered": the interpretation, the
 *                           full point list, the period queried, the gap
 *                           figures, the SQL and the cost. The PDF never
 *                           has it: the stored HTML is rendered with no
 *                           slot for it (html.ts), and REPORT_CSS hides it
 *                           under `@media print` for the web page's Print.
 *
 * No React state and no engine imports here, so the client toggle
 * (app/(modules)/bas/reports-planner-how.tsx) can import the panel without
 * pulling the engine - or Prisma - into the browser bundle.
 */

export const PLANNER_TABLE_MAX_ROWS = 12;
export const PLANNER_TABLE_MAX_COLUMNS = 6;
export const SHOW_HOW_LABEL = "Show how this was answered";
export const HIDE_HOW_LABEL = "Hide";

type Cell = string | number | boolean | null;

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function dateIn(d: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, day: "numeric", month: "short", year: "numeric" }).format(d);
}

function timeIn(d: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
}

/**
 * A result cell as the page prints it. An instant is a local date - with
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

/** The table as the page shows it: at most 12 rows and 6 columns, and a line saying what was left out. */
export function plannerTableView(table: NonNullable<PlannerAnswer["table"]>): { columns: string[]; rows: Cell[][]; shownLine: string | null } {
  const columns = table.columns.slice(0, PLANNER_TABLE_MAX_COLUMNS);
  const rows = table.rows.slice(0, PLANNER_TABLE_MAX_ROWS).map((r) => r.slice(0, PLANNER_TABLE_MAX_COLUMNS));
  const parts: string[] = [];
  if (table.rowCount > rows.length) parts.push(`${rows.length} of ${table.rowCount.toLocaleString("en-US")}${table.truncated ? "+" : ""} rows shown`);
  if (table.columns.length > columns.length) parts.push(`${columns.length} of ${table.columns.length} columns shown`);
  return { columns, rows, shownLine: parts.length === 0 ? null : parts.join(" · ") };
}

function rangeText(range: { start: string; end: string }, timezone: string): string {
  const start = dateIn(new Date(range.start), timezone);
  const end = dateIn(new Date(range.end), timezone);
  return start === end ? start : `${start} to ${end}`;
}

/** "the Occupied point", "the occupied hours entered for the building", or null for no source. */
export function occupancySourceWords(o: { kind: OccupancyKind; detail: string }): string | null {
  if (o.kind === "point") {
    const m = /^(.*) \(occupancy (status|command) point\)$/.exec(o.detail);
    return m === null ? o.detail : `the ${m[1]} point`;
  }
  if (o.kind === "manual") return "the occupied hours entered for the building";
  return null;
}

/** Whether the answer is about occupied hours: the question, how it was read, or its SQL says so. */
function concernsOccupancy(a: PlannerAnswer): boolean {
  return /occup/i.test([a.text, a.interpretation ?? "", a.sql ?? ""].join(" "));
}

/**
 * The one grey line under an answer: "Read 11 points on PHBoffice for 22
 * Sept 2026 to 29 Sept 2026; occupied hours from the Occupied point." The
 * occupancy clause only when the answer is about occupied hours - said of a
 * per-day reading count it would claim a filter the query never applied.
 * Null when nothing was read (the planner was not asked, or declined).
 */
export function plannerReadLine(
  a: PlannerAnswer,
  context: { stationNames: string[]; timezone: string; occupancy: ReadonlyArray<{ kind: OccupancyKind; detail: string }> },
): string | null {
  const p = a.provenance;
  if (p === null) return null;
  const where = context.stationNames.length > 0 ? context.stationNames.join(", ") : "this building";
  const points = p.pointCount === 0 ? "Read no points" : `Read ${p.pointCount} point${p.pointCount === 1 ? "" : "s"}`;
  const period = p.timeRange !== null ? ` for ${rangeText(p.timeRange, context.timezone)}` : p.periodUndeclared ? " for a period the planner did not state" : "";
  let occupancy = "";
  if (concernsOccupancy(a)) {
    const sources = [...new Set(context.occupancy.map(occupancySourceWords).filter((s): s is string => s !== null))];
    occupancy = sources.length === 0 ? "; no occupancy source on this building" : `; occupied hours from ${sources.join(" and ")}`;
  }
  return `${points} on ${where}${period}${occupancy}.`;
}

/** Whether there is anything behind the button. */
export function hasPlannerDetails(a: PlannerAnswer): boolean {
  return a.interpretation !== null || a.sql !== null || a.provenance !== null || a.calls > 0;
}

/**
 * Everything behind "Show how this was answered": how the planner read the
 * question, the period it queried, every point name kept on the run, the
 * gap figures, the SQL and the cost. The web run view only.
 */
export function PlannerHowPanel({ answer: a, timezone }: { answer: PlannerAnswer; timezone: string }) {
  const p = a.provenance;
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  return (
    <div className="planner-how-panel">
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
      {a.sql !== null && <pre className="sql">{a.sql}</pre>}
      <p className="planner-meta">
        {a.calls === 0 ? "No model call was made." : `${a.calls} model call${a.calls === 1 ? "" : "s"} · $${a.costUsd.toFixed(4)}`}
        {a.durationMs > 0 ? ` · ${Math.round(a.durationMs / 100) / 10} s` : ""}
        {a.retried ? " · the first plan was unusable and a second was asked for" : ""}
      </p>
    </div>
  );
}
