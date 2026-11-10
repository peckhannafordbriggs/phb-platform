/**
 * The standalone HTML of a report (Reports, Phase 2): the template in
 * `render.tsx` rendered to static markup under its own stylesheet, stored on
 * the run and, in Phase 4, printed to PDF.
 *
 * Its own module because Next refuses `react-dom/server` in any file a page
 * imports, and the Generated page imports the template. The engine and the
 * dev script import this; the page never does.
 */
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { REPORT_CSS, ReportView } from "./render";
import type { ReportDocument } from "./types";

export function renderReportHtml(doc: ReportDocument): string {
  const body = renderToStaticMarkup(createElement(ReportView, { document: doc }) as ReactNode);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(doc.header.buildingName)} BAS Health Report</title>
<style>${REPORT_CSS}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
