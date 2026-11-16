/** @jsxRuntime automatic @jsxImportSource react */
// The pragma, and it is load-bearing: this file is rendered by Next (its own
// transform), by vitest (oxc, automatic runtime) and by the dev script under
// tsx (esbuild, which reads tsconfig's jsx: preserve as the CLASSIC transform,
// React.createElement, and then wants a React in scope that nothing imports).
// Naming the runtime here makes all three agree. Without it the worker's
// render throws "React is not defined" - run 1 on the development database
// (2026-11-10) failed exactly so, minutes before this line existed - and no
// in-process test can see that, because vitest never compiles the file the
// way the worker does. tests/bas-reports-worker-render.test.ts spawns tsx on
// scripts/bas-report-render.ts and does.
import { BAS_LIBRARY_QUESTIONS, describeRequiredRoles } from "../library";
import { COLLECTION_STOPPED, DATA_HEALTH_QUESTION, incidentPoints } from "./analysis/data-health";
import { STATUS_LABELS } from "./rollup";
import { formatPlannerCell, plannerReadLine, plannerTableView } from "./planner-display";
import type { ReactNode } from "react";
import type {
  EquipmentTypeFound,
  Finding,
  PlannerAnswer,
  QuestionResult,
  ReportDocument,
  ScheduleResult,
  SectionDocument,
  SummaryDocument,
  ZoneResult,
} from "./types";
import {
  PLANNER_SECTION_NOTE,
  describeRunDuration,
  notApplicableLine,
  notMonitoredLine,
  notRunLine,
  plannerOutcomeLabel,
  positiveAnswer,
  questionHeading,
  skippedLine,
} from "./wording";

/**
 * The report template (Reports, Phase 2), as a server-renderable React
 * component, following the spec's template section for section: Point
 * Inventory, Summary, the equipment sections, Data Health, Open Items
 * Carried Forward. Sections marked Not Applicable are dropped, as the spec
 * says.
 *
 * EVERY QUESTION IS ON THE PAGE IN ITS OWN WORDS (2026-11-13). Within a
 * section, each question the report carries is a sub-heading - "Q3. What
 * percent of occupied hours did each zone hold within ±2°F of setpoint?" -
 * and directly under it is its answer: the findings it raised, or one
 * factual line when it ran and found nothing (written from the numbers the
 * analysis returned), or why it did not run - Not monitored with the
 * missing points, Not applicable with the reason, Not analysed with the
 * units it would have run over. The Point Inventory keeps its building lines
 * (equipment types, classification, coverage, occupancy source, points in
 * scope) and nothing per question - its Not Monitored bullets, its Not
 * Applicable line and its required-checks count went, because every question
 * is already in its section - the Summary heads its two halves with the
 * spec's first two questions, cleared findings are grouped under the question
 * they came from, and a custom question is its text over its note. A reader
 * with only the PDF never has to look up what "Q3" is.
 * The section's badge stays on the section heading.
 *
 * ONE TEMPLATE. The Generated sub-tab renders this component from the run's
 * stored document, and `renderReportHtml` (`html.ts`, kept apart because Next
 * refuses `react-dom/server` in anything a page imports) renders the same
 * component into the standalone page the worker prints to PDF. Every number
 * on the page comes from the document - the findings' evidence and the
 * questions' metrics - and never from the model's sentences, which are shown
 * in their own two columns (or, under a Data Health row and a Summary line,
 * their own second line) and nowhere else.
 *
 * Plain semantic markup with a small stylesheet of its own, because the
 * standalone page has no Tailwind. Inside the platform the same stylesheet
 * is scoped under `.bas-report`.
 *
 * Documents stored before 2026-11-12 are rendered too: their
 * `equipmentTypesFound` is a list of Step 1 words, they carry no
 * `classification` and no `durationMs`; those before 2026-11-13 carry no
 * `needs` on a question, no `questions` on the summary and no headline
 * metrics. Each is read defensively here rather than migrated: the library
 * supplies a question's words and requirements by key, and a positive line
 * says only what the stored metrics support.
 */

export const REPORT_CSS = `
.bas-report { font: 14px/1.45 Figtree, system-ui, sans-serif; color: #1f1a2e; max-width: 72rem; }
.bas-report h1 { font-size: 1.375rem; margin: 0 0 .25rem; }
.bas-report h2 { font-size: 1.0625rem; margin: 1.5rem 0 .5rem; display: flex; align-items: baseline; gap: .75rem; }
.bas-report h3 { font-size: .9375rem; font-weight: 600; line-height: 1.35; margin: 1rem 0 .25rem; }
.bas-report .meta { color: #5c5873; margin: 0 0 .25rem; }
.bas-report .status { display: inline-block; border: 1px solid; border-radius: .375rem; padding: .1rem .5rem; font-size: .75rem; font-weight: 600; }
.bas-report .status-good { color: #2f7d76; border-color: #6fc9c1; background: #ecf8f7; }
.bas-report .status-watch { color: #9e6408; border-color: #f3a11e; background: #fff6e5; }
.bas-report .status-action_needed { color: #88183c; border-color: #88183c; background: #fbeef2; }
.bas-report .status-not_monitored, .bas-report .status-not_run { color: #5c5873; border-color: #c9c5d6; background: #f5f4f8; }
.bas-report .sentence { margin: .25rem 0 .75rem; }
.bas-report .answer { margin: .25rem 0 .5rem; }
.bas-report table { border-collapse: collapse; width: 100%; margin: .5rem 0 1rem; font-size: .8125rem; }
.bas-report th, .bas-report td { text-align: left; vertical-align: top; padding: .35rem .5rem; border-top: 1px solid #e6e3ee; }
.bas-report th { color: #5c5873; font-weight: 600; }
.bas-report tr.narrative td { border-top: 0; padding-top: 0; color: #3d3852; }
.bas-report .mark { display: inline-block; border-radius: .25rem; padding: 0 .35rem; font-size: .6875rem; font-weight: 600; margin-left: .35rem; }
.bas-report .mark-new { background: #ebe6f2; color: #5b3192; }
.bas-report .mark-still_open { background: #fff6e5; color: #9e6408; }
.bas-report .mark-cleared { background: #ecf8f7; color: #2f7d76; }
.bas-report .muted { color: #5c5873; }
.bas-report .narrative-line { display: block; margin-top: .15rem; color: #3d3852; }
.bas-report ul { margin: .25rem 0 .75rem 1.25rem; padding: 0; }
.bas-report .partial { border: 1px solid #f3a11e; background: #fff6e5; padding: .5rem .75rem; border-radius: .375rem; margin: .75rem 0; }
.bas-report .incident { border: 1px solid #f3a11e; background: #fff6e5; padding: .5rem .75rem; border-radius: .375rem; margin: .5rem 0; }
.bas-report .incident p { margin: 0 0 .25rem; }
.bas-report .planner-meta { color: #5c5873; font-size: .8125rem; margin: .15rem 0; }
.bas-report pre.sql { white-space: pre-wrap; word-break: break-word; font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #3d3852; background: #f5f4f8; padding: .4rem .5rem; border-radius: .25rem; margin: .25rem 0 .5rem; }
.bas-report .planner-question .answer p { margin: .5rem 0; }
.bas-report .planner-question .answer ul { list-style: disc; }
.bas-report .planner-how { margin: .35rem 0 1rem; }
.bas-report .planner-how-panel { margin-top: .5rem; padding: .5rem .75rem; border: 1px solid #e6e3ee; border-radius: .375rem; background: #f5f4f8; font-size: .8125rem; }
.bas-report .planner-how-panel p { margin: 0 0 .35rem; }
@media print { .bas-report .planner-how { display: none !important; } }
`;

const STATE_WORDS: Record<Finding["state"], string> = { new: "New", still_open: "Still open", cleared: "Cleared" };
const PRIORITY_WORDS: Record<Finding["priority"], string> = { watch: "Watch", action_needed: "Action Needed" };

function Status({ status }: { status: SectionDocument["status"] }) {
  const label =
    status === "not_applicable"
      ? "Not Applicable"
      : status === "not_monitored"
        ? "Not Monitored"
        : status === "not_run"
          ? "Not run in this phase"
          : STATUS_LABELS[status];
  return <span className={`status status-${status}`}>{label}</span>;
}

function Mark({ state }: { state: Finding["state"] }) {
  return <span className={`mark mark-${state}`}>{STATE_WORDS[state]}</span>;
}

function since(f: Finding, timezone: string): string {
  if (f.firstSeenAt === null) return "—";
  return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, day: "numeric", month: "short" }).format(new Date(f.firstSeenAt));
}

/** The model's two sentences for a finding, as one line; null when neither was written. */
function NarrativeLine({ f }: { f: Finding }) {
  if (f.likelyCause === null && f.recommendedAction === null) return null;
  return (
    <span className="narrative-line">
      {f.likelyCause !== null && (
        <>
          <strong>Likely cause:</strong> {f.likelyCause}
        </>
      )}
      {f.likelyCause !== null && f.recommendedAction !== null ? " " : ""}
      {f.recommendedAction !== null && (
        <>
          <strong>Recommended action:</strong> {f.recommendedAction}
        </>
      )}
    </span>
  );
}

function FindingsTable({ findings, timezone, markers = true }: { findings: Finding[]; timezone: string; markers?: boolean }) {
  if (findings.length === 0) return null;
  return (
    <table>
      <thead>
        <tr>
          <th>Priority</th>
          <th>Equipment</th>
          <th>Issue</th>
          <th>Evidence</th>
          <th>Likely cause</th>
          <th>Recommended action</th>
          <th>Since</th>
        </tr>
      </thead>
      <tbody>
        {findings.map((f) => (
          <tr key={f.fingerprint}>
            <td>{PRIORITY_WORDS[f.priority]}</td>
            <td>
              {f.subjectName}
              {markers && <Mark state={f.state} />}
            </td>
            <td>{f.issue}</td>
            <td>
              {f.evidence.actual} vs. {f.evidence.expected}
              {f.evidence.percent !== undefined ? `, ${f.evidence.percent}% of the time` : f.evidence.duration !== undefined ? `, ${f.evidence.duration}` : ""}
              {f.evidence.when ? ` (${f.evidence.when})` : ""}
            </td>
            <td>{f.likelyCause ?? <span className="muted">—</span>}</td>
            <td>{f.recommendedAction ?? <span className="muted">—</span>}</td>
            <td>{since(f, timezone)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ZonesTable({ zones }: { zones: ZoneResult[] }) {
  if (zones.length === 0) return null;
  return (
    <table>
      <thead>
        <tr>
          <th>Zone</th>
          <th>% time out of range</th>
          <th>Max deviation</th>
          <th>When</th>
        </tr>
      </thead>
      <tbody>
        {zones.map((z) => (
          <tr key={z.equipmentId}>
            <td>{z.name}</td>
            <td>{z.percentInBand === null ? "—" : `${Math.round((100 - z.percentInBand) * 10) / 10}%`}</td>
            <td>{z.maxDeviationF === null ? "—" : `${z.maxDeviationF > 0 ? "+" : ""}${z.maxDeviationF.toFixed(1)} °F`}</td>
            <td>{z.worstHour === null ? "—" : `${String(z.worstHour).padStart(2, "0")}:00-${String((z.worstHour + 1) % 24).padStart(2, "0")}:00`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SchedulesTable({ rows }: { rows: ScheduleResult[] }) {
  if (rows.length === 0) return null;
  return (
    <table>
      <thead>
        <tr>
          <th>Equipment</th>
          <th>Hours run outside schedule</th>
          <th>Days</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.equipmentId}>
            <td>{r.name}</td>
            <td>{r.hoursOutside.toFixed(1)}</td>
            <td>{r.days}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The template's Hot Water and Chilled Water headline - "HWS on target: x%
 * | Avg delta T: x °F" - from Q13's and Q14's metrics, time-weighted over
 * every in-service hour (Phase 5). Absent when no loop was judged.
 */
function LoopHeadline({ q }: { q: QuestionResult }) {
  const onTarget = q.metrics.onTargetPercent;
  const delta = q.metrics.averageDeltaT;
  if (typeof onTarget !== "number" || typeof delta !== "number") return null;
  const label = typeof q.metrics.label === "string" ? q.metrics.label : q.key.startsWith("q13") ? "HWS" : "CHWS";
  return (
    <p>
      {label} on target: {onTarget}% | Avg delta T: {delta.toFixed(1)} °F
    </p>
  );
}

interface DxRow {
  name: string;
  peak: number | null;
  drop: number | null;
  rise: number | null;
}

/**
 * The template's DX table - Unit | Compressor starts/hr peak | Avg DAT drop
 * with compressors on | Avg DAT rise with heat on - assembled from the
 * per-unit metrics of Q15, Q16 and Q18 (Phase 5). A unit a question did not
 * judge reads "—" in that column. Absent when none of the three ran.
 */
export function dxTableRows(questions: readonly QuestionResult[]): DxRow[] {
  const rows = new Map<string, DxRow>();
  const row = (name: string) => {
    let r = rows.get(name);
    if (r === undefined) {
      r = { name, peak: null, drop: null, rise: null };
      rows.set(name, r);
    }
    return r;
  };
  for (const q of questions) {
    if (q.outcome !== "answered") continue;
    const units = Array.isArray(q.metrics.units) ? (q.metrics.units as Array<Record<string, unknown>>) : [];
    for (const u of units) {
      if (typeof u.name !== "string") continue;
      if (q.key === "q15_compressor_short_cycling" && typeof u.peakStartsPerHour === "number") row(u.name).peak = u.peakStartsPerHour;
      if (q.key === "q16_dx_cooling_delta" && typeof u.average === "number") row(u.name).drop = u.average;
      if (q.key === "q18_heat_stage_delta" && typeof u.average === "number") row(u.name).rise = u.average;
    }
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function DxTable({ questions }: { questions: readonly QuestionResult[] }) {
  const rows = dxTableRows(questions);
  if (rows.length === 0) return null;
  const f = (v: number | null, unit: string) => (v === null ? "—" : `${unit === "" ? v : v.toFixed(1)}${unit}`);
  return (
    <table>
      <thead>
        <tr>
          <th>Unit</th>
          <th>Compressor starts/hr peak</th>
          <th>Avg DAT drop with compressors on</th>
          <th>Avg DAT rise with heat on</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.name}>
            <td>{r.name}</td>
            <td>{f(r.peak, "")}</td>
            <td>{f(r.drop, " °F")}</td>
            <td>{f(r.rise, " °F")}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function periodText(doc: ReportDocument): string {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: doc.header.timezone, day: "numeric", month: "short", year: "numeric" });
  return `${f.format(new Date(doc.header.periodStart))} to ${f.format(new Date(doc.header.periodEnd))}`;
}

/**
 * A question as the library words it, for a document that stored no result
 * for it: the Summary's two on documents from before 2026-11-13, and Data
 * Health's on a document whose section carries no question list.
 */
function libraryQuestion(key: string): QuestionResult | null {
  const row = BAS_LIBRARY_QUESTIONS.find((q) => q.key === key);
  if (row === undefined) return null;
  return {
    key: row.key,
    position: row.position,
    section: row.section,
    text: row.text,
    kind: row.kind,
    outcome: "answered",
    needs: describeRequiredRoles(row.requiredRoles),
    missing: [],
    reason: null,
    equipment: [],
    skipped: [],
    metrics: {},
  };
}

const byPosition = (a: QuestionResult, b: QuestionResult) => a.position - b.position;

/** The Summary's questions: stored since 2026-11-13; the spec's first two from the library before. */
function summaryQuestions(summary: SummaryDocument): QuestionResult[] {
  const stored = (summary as { questions?: QuestionResult[] }).questions;
  if (Array.isArray(stored)) return [...stored].sort(byPosition);
  return BAS_LIBRARY_QUESTIONS.filter((q) => q.section === "summary")
    .map((q) => libraryQuestion(q.key))
    .filter((q): q is QuestionResult => q !== null)
    .sort(byPosition);
}

/** The words of the question a finding came from, for the cleared groups: a stored result first, the library second, the key last. */
function questionFor(doc: ReportDocument, key: string): Pick<QuestionResult, "position" | "text"> {
  for (const s of doc.sections) {
    const q = s.questions.find((x) => x.key === key);
    if (q !== undefined) return q;
  }
  return libraryQuestion(key) ?? { position: Number.POSITIVE_INFINITY, text: key };
}

/**
 * One question and its answer. The findings are the ones the question
 * raised this period (cleared ones are in their own section); a question
 * that raised none says what it checked, from its metrics; a question that
 * did not run says why, muted.
 */
function Question({ q, findings, timezone }: { q: QuestionResult; findings: Finding[]; timezone: string }) {
  const skipped = skippedLine(q.skipped);
  return (
    <>
      <h3>{questionHeading(q)}</h3>
      {q.outcome === "not_monitored" && <p className="answer muted">{notMonitoredLine(q.missing)}</p>}
      {q.outcome === "not_applicable" && <p className="answer muted">{notApplicableLine(q.reason)}</p>}
      {q.outcome === "not_run" && <p className="answer muted">{notRunLine(q)}</p>}
      {q.outcome === "answered" && <Answer q={q} findings={findings} timezone={timezone} />}
      {q.outcome === "answered" && skipped !== null && <p className="muted">{skipped}</p>}
    </>
  );
}

function Answer({ q, findings, timezone }: { q: QuestionResult; findings: Finding[]; timezone: string }) {
  const overall = q.metrics.overallPercentInBand as number | null | undefined;
  const worst = (q.metrics.worstZones as ZoneResult[] | undefined) ?? [];
  const schedules = (q.metrics.schedules as ScheduleResult[] | undefined) ?? [];
  // The worst-zones question is answered by its table; its findings are Q3's.
  if (q.key === "q04_worst_zones") {
    return <div className="answer">{worst.length === 0 ? <p>{positiveAnswer(q)}</p> : <ZonesTable zones={worst} />}</div>;
  }
  return (
    <div className="answer">
      {q.key === "q03_zone_comfort" && overall !== undefined && overall !== null && (
        <p>Zones within ±2 °F of setpoint during occupancy: {overall}%</p>
      )}
      {q.key === "q19_run_outside_schedule" && <SchedulesTable rows={schedules} />}
      {(q.key === "q13_hw_supply_and_delta_t" || q.key === "q14_chw_supply_and_delta_t") && <LoopHeadline q={q} />}
      {findings.length === 0 ? <p>{positiveAnswer(q)}</p> : <FindingsTable findings={findings} timezone={timezone} />}
    </div>
  );
}

function Section({ section, timezone, index }: { section: SectionDocument; timezone: string; index: number }) {
  if (section.status === "not_applicable") return null;
  const questions = [...section.questions].sort(byPosition);
  const live = section.findings.filter((f) => f.state !== "cleared");
  // A finding whose question is not on the page - a report whose question
  // list changed after the run - is still shown, after the questions.
  const unplaced = live.filter((f) => !questions.some((q) => q.key === f.questionKey));
  const judged = section.status === "good" || section.status === "watch" || section.status === "action_needed";

  return (
    <section>
      <h2>
        {index}. {section.label} <Status status={section.status} />
      </h2>
      {judged && section.statusSentence && <p className="sentence">{section.statusSentence}</p>}
      {section.key === "dx" && <DxTable questions={questions} />}
      {questions.map((q) => (
        <Question key={q.key} q={q} findings={live.filter((f) => f.questionKey === q.key)} timezone={timezone} />
      ))}
      <FindingsTable findings={unplaced} timezone={timezone} />
    </section>
  );
}

/** "Rooftop Unit × 1, VAV Box × 10"; a document from before 2026-11-12 holds Step 1 words and is printed as it was. */
function equipmentTypesText(found: ReadonlyArray<EquipmentTypeFound | string>): string {
  if (found.length === 0) return "none in scope";
  return found.map((t) => (typeof t === "string" ? t : `${t.label} × ${t.count}`)).join(", ");
}

function DataHealthSection({ section, index }: { section: SectionDocument; index: number }) {
  const question = section.questions.find((q) => q.key === DATA_HEALTH_QUESTION) ?? section.questions[0] ?? libraryQuestion(DATA_HEALTH_QUESTION);
  const live = section.findings.filter((f) => f.state !== "cleared");
  const incidents = live.filter((f) => f.issueCode === COLLECTION_STOPPED);
  const rows = live.filter((f) => f.issueCode !== COLLECTION_STOPPED);
  const memberRows = incidents.flatMap((incident) => incidentPoints(incident.evidence).map((p) => ({ incident, p })));

  return (
    <section>
      <h2>
        {index}. Data Health <Status status={section.status} />
      </h2>
      {section.statusSentence && <p className="sentence">{section.statusSentence}</p>}
      {question !== null && <h3>{questionHeading(question)}</h3>}
      {incidents.map((f) => {
        const points = incidentPoints(f.evidence);
        return (
          <div className="incident" key={f.fingerprint}>
            <p>
              <strong>Collection incident on {f.subjectName}</strong>
              <Mark state={f.state} />: {f.evidence.actual}; {f.evidence.when}
              {f.evidence.duration !== undefined ? `, ${f.evidence.duration} to the end of the period` : ""}. Counted as one finding; the points are
              the rows below.
            </p>
            <p className="muted">{points.map((p) => p.name).join(", ")}</p>
            <NarrativeLine f={f} />
          </div>
        );
      })}
      {live.length === 0 ? (
        <p className="answer">{question === null ? "No data problems found in the period." : positiveAnswer(question)}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Point</th>
              <th>Problem</th>
              <th>Evidence</th>
              <th>Since</th>
            </tr>
          </thead>
          <tbody>
            {memberRows.map(({ incident, p }) => (
              <tr key={`${incident.fingerprint}:${p.pointId}`}>
                <td>
                  {p.name}
                  <Mark state={incident.state} />
                </td>
                <td>{p.issue}</td>
                <td>
                  {p.actual}; expected {p.expected}
                  {p.duration ? `; for ${p.duration}` : ""}
                </td>
                <td>{p.when}</td>
              </tr>
            ))}
            {rows.map((f) => (
              <tr key={f.fingerprint}>
                <td>
                  {f.subjectName}
                  <Mark state={f.state} />
                </td>
                <td>{f.issue}</td>
                <td>
                  {f.evidence.actual}; expected {f.evidence.expected}
                  {f.evidence.duration !== undefined ? `; for ${f.evidence.duration}` : ""}
                </td>
                <td>{f.evidence.when}</td>
              </tr>
            ))}
            {rows.map((f) =>
              f.likelyCause === null && f.recommendedAction === null ? null : (
                <tr key={`${f.fingerprint}:narrative`} className="narrative">
                  <td colSpan={4}>
                    <span className="muted">{f.subjectName}:</span> <NarrativeLine f={f} />
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      )}
    </section>
  );
}

/**
 * The planner's answer text: its paragraphs, and its "- " lines as a list,
 * which is the one structure the summariser is allowed (docs/11).
 */
function AnswerText({ text }: { text: string }) {
  const blocks: Array<{ kind: "p"; text: string } | { kind: "ul"; items: string[] }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith("- ")) {
      const last = blocks[blocks.length - 1];
      if (last !== undefined && last.kind === "ul") last.items.push(line.slice(2));
      else blocks.push({ kind: "ul", items: [line.slice(2)] });
    } else {
      blocks.push({ kind: "p", text: line });
    }
  }
  return (
    <div className="answer">
      {blocks.map((b, i) =>
        b.kind === "p" ? (
          <p key={i}>{b.text}</p>
        ) : (
          <ul key={i}>
            {b.items.map((item, j) => (
              <li key={j}>{item}</li>
            ))}
          </ul>
        ),
      )}
    </div>
  );
}

/**
 * The web run view's slot under each planner answer: the "Show how this was
 * answered" toggle (app/(modules)/bas/reports-planner-how.tsx). Absent on
 * the stored HTML and so in the PDF - html.ts renders ReportView with no
 * slot - and hidden by REPORT_CSS's print rule when the web page is printed.
 */
export type PlannerDetailsSlot = (answer: PlannerAnswer, timezone: string) => ReactNode;

/**
 * One planner question as the page and the PDF show it (2026-11-16): its
 * words, the answer in prose or why there is none, the amber checks, a
 * small results table, and one grey line saying what was read. How the
 * planner got there - its reading, every point, the SQL, the cost - is on
 * the run and behind the web view's button, not here.
 */
function PlannerQuestion({ a, doc, details }: { a: PlannerAnswer; doc: ReportDocument; details?: PlannerDetailsSlot }) {
  const label = plannerOutcomeLabel(a.outcome);
  const p = a.provenance;
  const tz = doc.header.timezone;
  // A no-data answer has no rows worth a table (none, or one of NULLs); its reason says so.
  const view = a.outcome === "answered" && a.table !== null && a.table.rowCount > 0 ? plannerTableView(a.table) : null;
  const readLine = plannerReadLine(a, { stationNames: doc.header.stationNames, timezone: tz, occupancy: doc.inventory.occupancy });
  return (
    <div className="planner-question">
      <h3>
        {a.text}
        {a.source === "library" && <span className="muted"> · shared question{a.sectionLabel ? `, ${a.sectionLabel}` : ""}</span>}
      </h3>
      {a.outcome === "answered" && a.answer !== null && <AnswerText text={a.answer} />}
      {a.outcome !== "answered" && a.reason !== null && (
        <p className="answer muted">
          {label !== null && <strong>{label}: </strong>}
          {a.reason}
        </p>
      )}
      {a.notes.map((note, i) => (
        <p className="partial" key={i}>
          {note}
        </p>
      ))}
      {p !== null && p.coverageShortfall !== null && <p className="partial">{p.coverageShortfall}</p>}
      {view !== null && (
        <>
          <table>
            <thead>
              <tr>
                {view.columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {view.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j}>{formatPlannerCell(cell, tz)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {view.shownLine !== null && <p className="planner-meta">{view.shownLine}</p>}
        </>
      )}
      {readLine !== null && <p className="planner-meta">{readLine}</p>}
      {details?.(a, tz)}
    </div>
  );
}

/**
 * Planner questions (Phase 6): the report's typed, personal and shared
 * planner-kind questions, each answered by the Analyze planner. One note in
 * the header says they are shown and not tracked; nothing in this section
 * carries a marker or a status badge, and nothing in it feeds the Summary.
 */
function PlannerSection({ doc, details }: { doc: ReportDocument; details?: PlannerDetailsSlot }) {
  return (
    <section>
      <h2>Planner questions</h2>
      <p className="muted">{PLANNER_SECTION_NOTE}</p>
      {[...(doc.plannerAnswers ?? [])]
        .sort((x, y) => x.position - y.position)
        .map((a) => (
          <PlannerQuestion key={`${a.position}:${a.text}`} a={a} doc={doc} details={details} />
        ))}
    </section>
  );
}

/** "VAV-3 (Zone above setpoint), points_RoomT (Out of physical range)": the findings behind a Summary count, one entry each. */
function findingList(findings: Finding[]): string {
  return findings.map((f) => `${f.subjectName} (${f.issue})`).join(", ");
}

function uniqueByFingerprint(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of findings) {
    if (seen.has(f.fingerprint)) continue;
    seen.add(f.fingerprint);
    out.push(f);
  }
  return out;
}

export function ReportView({ document: doc, plannerDetails }: { document: ReportDocument; plannerDetails?: PlannerDetailsSlot }) {
  const { header, inventory, summary } = doc;
  const renderable = doc.sections.filter((s) => s.status !== "not_applicable");
  const dataHealth = renderable.find((s) => s.key === "data_health");
  const others = renderable.filter((s) => s.key !== "data_health");
  const classification = inventory.classification ?? [];
  const durationMs = header.durationMs ?? null;
  const summaryQs = summaryQuestions(summary);
  const statusQuestion = summaryQs.find((q) => q.key === "q01_building_status") ?? null;
  const changesQuestion = summaryQs.find((q) => q.key === "q02_changes_since_last") ?? null;
  const sectionFindings = doc.sections.flatMap((s) => s.findings);
  const newFindings = uniqueByFingerprint(sectionFindings.filter((f) => f.state === "new"));
  const stillOpen = uniqueByFingerprint(sectionFindings.filter((f) => f.state === "still_open"));
  const clearedFindings = uniqueByFingerprint([...doc.cleared, ...sectionFindings.filter((f) => f.state === "cleared")]);
  const clearedGroups = [...new Set(doc.cleared.map((f) => f.questionKey))]
    .map((key) => ({ key, question: questionFor(doc, key), findings: doc.cleared.filter((f) => f.questionKey === key) }))
    .sort((a, b) => a.question.position - b.question.position);

  return (
    <article className="bas-report">
      <h1>{header.buildingName} BAS Health Report</h1>
      <p className="meta">
        Period: {periodText(doc)} ({header.windowLabel}) | JACE: {header.stationNames.join(", ") || "—"} | {header.timezone}
      </p>
      <p className="meta">
        {header.outdoor === null
          ? "Outdoor conditions: no outside air temperature trended"
          : `Outdoor conditions: avg ${header.outdoor.avgF}°F, high ${header.outdoor.highF}°F, low ${header.outdoor.lowF}°F (${header.outdoor.pointName})`}
      </p>
      <p className="meta">
        {header.definitionName}
        {header.presetLabel ? ` · ${header.presetLabel}` : ""} · generated{" "}
        {new Intl.DateTimeFormat("en-GB", { timeZone: header.timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(header.generatedAt))}
      </p>
      {header.status === "partial" && header.partialReason && <p className="partial">Partial report: {header.partialReason}</p>}

      <h2>0. Point Inventory</h2>
      <p>Equipment types found: {equipmentTypesText(inventory.equipmentTypesFound)}</p>
      {classification.length > 0 && (
        <p>Classification: {classification.map((c) => `${c.name}: ${c.text}`).join("; ")}</p>
      )}
      <p>
        Points with under 80% trend coverage:{" "}
        {inventory.lowCoverage.length === 0 ? "none" : inventory.lowCoverage.map((p) => `${p.name} (${Math.round(p.coverage * 100)}%)`).join(", ")}
      </p>
      <p>
        Occupancy source:{" "}
        {inventory.occupancy.map((o) => `${o.stationName}: ${o.detail}`).join("; ") || "no stations in scope"}
      </p>
      <p className="muted">
        {inventory.pointsInScope} points on {inventory.equipmentInScope} pieces of equipment were in scope.
      </p>

      <h2>
        1. Summary <Status status={summary.status} />
      </h2>
      {statusQuestion !== null && <h3>{questionHeading(statusQuestion)}</h3>}
      <p>Overall status: {STATUS_LABELS[summary.status]}</p>
      <ul>
        {summary.topFindings.length === 0 && <li>No findings. Everything judged was within tolerance.</li>}
        {summary.topFindings.map((f) => (
          <li key={f.fingerprint}>
            {PRIORITY_WORDS[f.priority]}: {f.subjectName} — {f.issue} ({f.evidence.actual})
            <Mark state={f.state} />
            <NarrativeLine f={f} />
          </li>
        ))}
        <li>
          Needs site visit: {summary.siteVisit.length > 0 ? summary.siteVisit.join(", ") : "none identified"} | Remote fix:{" "}
          {summary.remoteFix.length > 0 ? summary.remoteFix.join(", ") : "none identified"}
        </li>
      </ul>
      {changesQuestion !== null && <h3>{questionHeading(changesQuestion)}</h3>}
      <ul>
        <li>
          New this period: {summary.counts.new}
          {newFindings.length > 0 ? ` — ${findingList(newFindings)}` : ""}
        </li>
        <li>
          Still open: {summary.counts.stillOpen}
          {stillOpen.length > 0 ? ` — ${findingList(stillOpen)}` : ""}
        </li>
        <li>
          Cleared this period: {summary.counts.cleared}
          {clearedFindings.length > 0 ? ` — ${findingList(clearedFindings)}` : ""}
        </li>
      </ul>

      {others.map((s, i) => (
        <Section key={s.key} section={s} timezone={header.timezone} index={i + 2} />
      ))}

      {dataHealth !== undefined && <DataHealthSection section={dataHealth} index={others.length + 2} />}

      {doc.cleared.length > 0 && (
        <section>
          <h2>Cleared since the previous report</h2>
          {clearedGroups.map((g) => (
            <div key={g.key}>
              <h3>{Number.isFinite(g.question.position) ? questionHeading(g.question) : g.question.text}</h3>
              <FindingsTable findings={g.findings} timezone={header.timezone} />
            </div>
          ))}
        </section>
      )}

      <section>
        <h2>Open Items Carried Forward</h2>
        {doc.carriedForward.length === 0 ? (
          <p className="muted">No unresolved Action Needed items from earlier reports.</p>
        ) : (
          <FindingsTable findings={doc.carriedForward} timezone={header.timezone} markers={false} />
        )}
      </section>

      {doc.plannerAnswers !== undefined && doc.plannerAnswers.length > 0 && (
        <PlannerSection doc={doc} details={plannerDetails} />
      )}

      {doc.plannerAnswers === undefined && doc.plannerQuestions.length > 0 && (
        <section>
          <h2>Custom questions</h2>
          {doc.plannerQuestions.map((q, i) => (
            <div key={i}>
              <h3>{q.text}</h3>
              <p className="answer muted">{q.note}</p>
            </div>
          ))}
        </section>
      )}

      <p className="muted">
        Model: {doc.cost.model ?? "none"} · {doc.cost.calls} call{doc.cost.calls === 1 ? "" : "s"} · {doc.cost.inputTokens + doc.cost.outputTokens} tokens · $
        {doc.cost.costUsd.toFixed(4)}
        {durationMs !== null ? ` · took ${describeRunDuration(durationMs)}` : ""}
      </p>
    </article>
  );
}
