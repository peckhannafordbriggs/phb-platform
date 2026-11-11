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
import { STATUS_LABELS } from "./rollup";
import type { Finding, ReportDocument, SectionDocument, ZoneResult, ScheduleResult } from "./types";

/**
 * The report template (Reports, Phase 2), as a server-renderable React
 * component, following the spec's template section for section: Point
 * Inventory, Summary, the equipment sections, Data Health, Open Items
 * Carried Forward. Sections marked Not Applicable are dropped, as the spec
 * says; Not Monitored ones say so with the missing points.
 *
 * ONE TEMPLATE. The Generated sub-tab renders this component from the run's
 * stored document, and `renderReportHtml` (`html.ts`, kept apart because Next
 * refuses `react-dom/server` in anything a page imports) renders the same
 * component into the standalone page Phase 4 will print to PDF. Every number on the page
 * comes from the document - the findings' evidence and the sections'
 * metrics - and never from the model's sentences, which are shown in their
 * own two columns and nowhere else.
 *
 * Plain semantic markup with a small stylesheet of its own, because the
 * standalone page has no Tailwind. Inside the platform the same stylesheet
 * is scoped under `.bas-report`.
 */

export const REPORT_CSS = `
.bas-report { font: 14px/1.45 Figtree, system-ui, sans-serif; color: #1f1a2e; max-width: 72rem; }
.bas-report h1 { font-size: 1.375rem; margin: 0 0 .25rem; }
.bas-report h2 { font-size: 1.0625rem; margin: 1.5rem 0 .5rem; display: flex; align-items: baseline; gap: .75rem; }
.bas-report .meta { color: #5c5873; margin: 0 0 .25rem; }
.bas-report .status { display: inline-block; border: 1px solid; border-radius: .375rem; padding: .1rem .5rem; font-size: .75rem; font-weight: 600; }
.bas-report .status-good { color: #2f7d76; border-color: #6fc9c1; background: #ecf8f7; }
.bas-report .status-watch { color: #9e6408; border-color: #f3a11e; background: #fff6e5; }
.bas-report .status-action_needed { color: #88183c; border-color: #88183c; background: #fbeef2; }
.bas-report .status-not_monitored, .bas-report .status-not_run { color: #5c5873; border-color: #c9c5d6; background: #f5f4f8; }
.bas-report .sentence { margin: .25rem 0 .75rem; }
.bas-report table { border-collapse: collapse; width: 100%; margin: .5rem 0 1rem; font-size: .8125rem; }
.bas-report th, .bas-report td { text-align: left; vertical-align: top; padding: .35rem .5rem; border-top: 1px solid #e6e3ee; }
.bas-report th { color: #5c5873; font-weight: 600; }
.bas-report .mark { display: inline-block; border-radius: .25rem; padding: 0 .35rem; font-size: .6875rem; font-weight: 600; margin-left: .35rem; }
.bas-report .mark-new { background: #ebe6f2; color: #5b3192; }
.bas-report .mark-still_open { background: #fff6e5; color: #9e6408; }
.bas-report .mark-cleared { background: #ecf8f7; color: #2f7d76; }
.bas-report .muted { color: #5c5873; }
.bas-report ul { margin: .25rem 0 .75rem 1.25rem; padding: 0; }
.bas-report .partial { border: 1px solid #f3a11e; background: #fff6e5; padding: .5rem .75rem; border-radius: .375rem; margin: .75rem 0; }
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

function periodText(doc: ReportDocument): string {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: doc.header.timezone, day: "numeric", month: "short", year: "numeric" });
  return `${f.format(new Date(doc.header.periodStart))} to ${f.format(new Date(doc.header.periodEnd))}`;
}

function Section({ section, timezone, index }: { section: SectionDocument; timezone: string; index: number }) {
  if (section.status === "not_applicable") return null;
  const metrics = section.questions.reduce<Record<string, unknown>>((acc, q) => ({ ...acc, ...q.metrics }), {});
  const zones = (metrics.worstZones as ZoneResult[] | undefined) ?? [];
  const overall = metrics.overallPercentInBand as number | null | undefined;
  const schedules = (metrics.schedules as ScheduleResult[] | undefined) ?? [];
  const notMonitored = section.questions.filter((q) => q.outcome === "not_monitored");
  const notRun = section.questions.filter((q) => q.outcome === "not_run");

  return (
    <section>
      <h2>
        {index}. {section.label} <Status status={section.status} />
      </h2>
      {section.statusSentence && <p className="sentence">{section.statusSentence}</p>}
      {section.key === "space_comfort" && overall !== undefined && overall !== null && (
        <p>Zones within ±2 °F of setpoint during occupancy: {overall}%</p>
      )}
      {section.key === "space_comfort" && <ZonesTable zones={zones} />}
      {section.key === "schedules" && <SchedulesTable rows={schedules} />}
      <FindingsTable findings={section.findings.filter((f) => f.state !== "cleared")} timezone={timezone} />
      {notMonitored.length > 0 && (
        <ul>
          {notMonitored.map((q) => (
            <li key={q.key} className="muted">
              Q{q.position} not monitored: missing {q.missing.join("; ")}
              {q.skipped.length > 0 && q.equipment.length > 0 ? ` (${q.skipped.map((s) => s.name).join(", ")})` : ""}
            </li>
          ))}
        </ul>
      )}
      {notRun.length > 0 && (
        <ul>
          {notRun.map((q) => (
            <li key={q.key} className="muted">
              Q{q.position}: {q.reason}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ReportView({ document: doc }: { document: ReportDocument }) {
  const { header, inventory, summary } = doc;
  const renderable = doc.sections.filter((s) => s.status !== "not_applicable");
  const dataHealth = renderable.find((s) => s.key === "data_health");
  const others = renderable.filter((s) => s.key !== "data_health");

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
      <p>
        Equipment types found: {inventory.equipmentTypesFound.length > 0 ? inventory.equipmentTypesFound.join(" / ") : "none identified from the points"}
      </p>
      <p>
        Required points found: {inventory.requiredPointsFound} of {inventory.requiredPointsTotal} | Points with under 80% trend coverage:{" "}
        {inventory.lowCoverage.length === 0 ? "none" : inventory.lowCoverage.map((p) => `${p.name} (${Math.round(p.coverage * 100)}%)`).join(", ")}
      </p>
      <p>
        Occupancy source:{" "}
        {inventory.occupancy.map((o) => `${o.stationName}: ${o.detail}`).join("; ") || "no stations in scope"}
      </p>
      <p className="muted">
        {inventory.pointsInScope} points on {inventory.equipmentInScope} pieces of equipment were in scope.
      </p>
      {inventory.notMonitored.length > 0 && (
        <>
          <p>Not Monitored:</p>
          <ul>
            {inventory.notMonitored.map((q) => (
              <li key={q.key}>
                Q{q.position}: missing {q.missing.join("; ")}
              </li>
            ))}
          </ul>
        </>
      )}
      {inventory.notApplicable.length > 0 && (
        <p className="muted">
          Not Applicable and left out: {inventory.notApplicable.map((q) => `Q${q.position} (${q.reason})`).join(", ")}
        </p>
      )}

      <h2>
        1. Summary <Status status={summary.status} />
      </h2>
      <p>Overall status: {STATUS_LABELS[summary.status]}</p>
      <ul>
        {summary.topFindings.length === 0 && <li>No findings. Everything judged was within tolerance.</li>}
        {summary.topFindings.map((f) => (
          <li key={f.fingerprint}>
            {PRIORITY_WORDS[f.priority]}: {f.subjectName} — {f.issue} ({f.evidence.actual})
            <Mark state={f.state} />
          </li>
        ))}
        <li>
          New this period: {summary.counts.new} / Cleared this period: {summary.counts.cleared} / Still open: {summary.counts.stillOpen}
        </li>
        <li>
          Needs site visit: {summary.siteVisit.length > 0 ? summary.siteVisit.join(", ") : "none identified"} | Remote fix:{" "}
          {summary.remoteFix.length > 0 ? summary.remoteFix.join(", ") : "none identified"}
        </li>
      </ul>

      {others.map((s, i) => (
        <Section key={s.key} section={s} timezone={header.timezone} index={i + 2} />
      ))}

      {dataHealth !== undefined && (
        <section>
          <h2>
            {others.length + 2}. Data Health <Status status={dataHealth.status} />
          </h2>
          {dataHealth.statusSentence && <p className="sentence">{dataHealth.statusSentence}</p>}
          {dataHealth.findings.filter((f) => f.state !== "cleared").length === 0 ? (
            <p>No data problems found in the period.</p>
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
                {dataHealth.findings
                  .filter((f) => f.state !== "cleared")
                  .map((f) => (
                    <tr key={f.fingerprint}>
                      <td>
                        {f.subjectName}
                        <Mark state={f.state} />
                      </td>
                      <td>{f.issue}</td>
                      <td>
                        {f.evidence.actual}; expected {f.evidence.expected}
                      </td>
                      <td>{f.evidence.when}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {doc.cleared.length > 0 && (
        <section>
          <h2>Cleared since the previous report</h2>
          <FindingsTable findings={doc.cleared} timezone={header.timezone} />
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

      {doc.plannerQuestions.length > 0 && (
        <section>
          <h2>Custom questions</h2>
          <ul>
            {doc.plannerQuestions.map((q, i) => (
              <li key={i} className="muted">
                {q.text} — {q.note}
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="muted">
        Model: {doc.cost.model ?? "none"} · {doc.cost.calls} call{doc.cost.calls === 1 ? "" : "s"} · {doc.cost.inputTokens + doc.cost.outputTokens} tokens · $
        {doc.cost.costUsd.toFixed(4)} of ${doc.cost.budgetUsd.toFixed(2)}
      </p>
    </article>
  );
}

