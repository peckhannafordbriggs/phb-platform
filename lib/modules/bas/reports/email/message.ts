import { periodLabel } from "../pdf/naming";
import { STATUS_LABELS } from "../engine/rollup";
import type { Finding, ReportDocument } from "../engine/types";
import { questionLabel } from "../engine/wording";

/**
 * What a report email says (Reports, Phase 4, the email half - 2026-11-17).
 * Pure: the worker hands in what it read from the run, this returns the
 * subject and the HTML, and a test reads both without a database or Graph.
 *
 * The body is a SHORT summary, not the report: the building's status, the
 * three top findings, the counts of New / Still open / Cleared, which
 * questions were Not monitored, and a link to the run on the platform. The
 * report itself is the attached PDF - when it fits under Graph's
 * simple-upload limit - or the platform page. Every number comes from the
 * stored document the page was rendered from; nothing here asks the model.
 *
 * Every string from the run - the report's name, the building's, a finding's
 * subject and words, a partial reason - is escaped. A report name is typed
 * by a person and a subject name comes from Niagara.
 */

/** The run page, the same path the Reports list links to. */
export function runLink(platformUrl: string | null, runId: string): string | null {
  return platformUrl === null ? null : `${platformUrl}/bas/reports/generated/${encodeURIComponent(runId)}`;
}

/** "<Report name> — <building> — <period>": the plan's subject line, period as the PDF's file name gives it. */
export function reportEmailSubject(input: Pick<ReportEmailInput, "reportName" | "buildingName" | "periodStart" | "periodEnd" | "timezone">): string {
  const oneLine = (s: string) => s.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  return `${oneLine(input.reportName)} — ${oneLine(input.buildingName)} — ${periodLabel(input.periodStart, input.periodEnd, input.timezone)}`;
}

export type EmailPdf =
  | { kind: "attached"; fileName: string; bytes: number }
  | { kind: "too_large"; bytes: number; limitBytes: number }
  | { kind: "unavailable"; reason: string };

export interface ReportEmailInput {
  runId: string;
  reportName: string;
  buildingName: string;
  periodStart: Date;
  periodEnd: Date;
  timezone: string;
  runStatus: "succeeded" | "partial";
  partialReason: string | null;
  /** The stored document; null only for a run that somehow has none, and the body then says so. */
  document: ReportDocument | null;
  platformUrl: string | null;
  pdf: EmailPdf;
}

export interface ReportEmail {
  subject: string;
  html: string;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STATE_WORDS: Record<Finding["state"], string> = { new: "New", still_open: "Still open", cleared: "Cleared" };
const PRIORITY_WORDS: Record<Finding["priority"], string> = { watch: "Watch", action_needed: "Action Needed" };

/** How many findings the body lists. The rest are in the report. */
export const EMAIL_TOP_FINDINGS = 3;

export function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The one line about the PDF, in words. */
export function pdfLine(pdf: EmailPdf): string {
  switch (pdf.kind) {
    case "attached":
      return `The full report is attached as a PDF (${megabytes(pdf.bytes)}).`;
    case "too_large":
      return `The PDF is ${megabytes(pdf.bytes)}, more than the ${megabytes(pdf.limitBytes)} an email from the platform can carry, so it is not attached. Open the report on the platform to read it or download the PDF.`;
    case "unavailable":
      return `No PDF is attached: ${pdf.reason} The report is on the platform.`;
  }
}

/** "Not monitored: Q6, Q7, Q9 - the building does not trend the points they need." or "Not monitored: none." */
export function notMonitoredLine(document: ReportDocument | null): string {
  const items = document?.inventory?.notMonitored ?? [];
  if (items.length === 0) return "Not monitored: none.";
  const labels = [...items].sort((a, b) => a.position - b.position).map((q) => questionLabel(q.position));
  return `Not monitored: ${labels.join(", ")} - the building does not trend the points ${items.length === 1 ? "that question needs" : "those questions need"}.`;
}

export function buildReportEmail(input: ReportEmailInput): ReportEmail {
  const e = escapeHtml;
  const doc = input.document;
  const summary = doc?.summary ?? null;
  const link = runLink(input.platformUrl, input.runId);

  const p = (html: string, style = "") => `<p style="margin:0 0 12px;${style}">${html}</p>`;
  const parts: string[] = [];

  parts.push(
    p(
      `<strong>${e(input.reportName)}</strong><br>${e(input.buildingName)} &middot; ${e(periodLabel(input.periodStart, input.periodEnd, input.timezone))}`,
    ),
  );

  if (summary !== null) {
    parts.push(p(`Building status: <strong>${e(STATUS_LABELS[summary.status] ?? summary.status)}</strong>`));
  } else {
    parts.push(p("The run stored no summary; the report on the platform says what it found."));
  }

  if (input.runStatus === "partial") {
    parts.push(
      p(
        `This run finished partial${input.partialReason !== null ? `: ${e(input.partialReason)}` : "."}`,
        "padding:8px 10px;border:1px solid #f3a11e;background:#fff6e5;",
      ),
    );
  }

  if (summary !== null) {
    const top = summary.topFindings.slice(0, EMAIL_TOP_FINDINGS);
    if (top.length === 0) {
      parts.push(p("Top findings: none this period."));
    } else {
      const items = top
        .map(
          (f) =>
            `<li style="margin:0 0 6px;">${e(PRIORITY_WORDS[f.priority] ?? f.priority)} &middot; ${e(STATE_WORDS[f.state] ?? f.state)}: <strong>${e(f.subjectName)}</strong> - ${e(f.issue)}</li>`,
        )
        .join("");
      parts.push(`${p("Top findings:", "margin-bottom:4px;")}<ul style="margin:0 0 12px;padding-left:20px;">${items}</ul>`);
    }
    const c = summary.counts;
    parts.push(p(`New: ${c.new} &middot; Still open: ${c.stillOpen} &middot; Cleared: ${c.cleared}`));
  }

  parts.push(p(e(notMonitoredLine(doc))));
  parts.push(p(e(pdfLine(input.pdf))));
  parts.push(
    link !== null
      ? p(`<a href="${e(link)}">Open the report on the platform</a>`)
      : p(`Open it on the platform: BAS &rarr; Reports &rarr; ${e(input.reportName)}.`),
  );
  parts.push(
    p(
      "Sent by the PH+B platform. You receive this because you own this report or are on its recipient list.",
      "color:#5c5873;font-size:12px;",
    ),
  );

  const html =
    `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.45;color:#1f1b2e;">` +
    parts.join("") +
    `</body></html>`;

  return { subject: reportEmailSubject(input), html };
}
