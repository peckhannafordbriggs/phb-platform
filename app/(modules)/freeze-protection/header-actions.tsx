"use client";

import { usePathname, useRouter } from "next/navigation";
import { Download, FileDown, Plus, Printer } from "lucide-react";
import { Button } from "./ui/kit";
import { REPORT_ID } from "./views/report-view";

type ProjectOption = { id: string; jobNumber: string; name: string };

/** Which project Register and Report show. Changing it rewrites `?project=`; All projects goes back to the catalog. */
export function ProjectPicker({ projects, value }: { projects: ProjectOption[]; value: string }) {
  const router = useRouter();
  const pathname = usePathname();
  return (
    <label className="flex items-center gap-2">
      <span className="eyebrow text-[var(--muted)]">Project</span>
      <select
        value={value}
        onChange={(e) => router.push(e.target.value ? `${pathname}?project=${encodeURIComponent(e.target.value)}` : pathname)}
        className="h-9 max-w-[20rem] truncate rounded-[var(--radius-control)] border border-[var(--border)] bg-white px-3 text-[0.8125rem]"
      >
        <option value="">All projects</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.jobNumber} · {p.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * The blank verification form (import/form.ts), from GET /import/form behind the
 * grant. A plain link, not the kit's Button: Button renders a Next Link, which
 * would prefetch an API route. Shown with or without a project, so a field team
 * can be handed the form before the job is set up here.
 */
export const TEMPLATE_URL = "/api/modules/freeze-protection/import/form";

export function TemplateLink() {
  return (
    <a
      href={TEMPLATE_URL}
      download
      title="Download the blank freeze protection verification form. Fill it in, then Import it on a project."
      className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-[var(--radius-control)] border border-[var(--border)] bg-white px-4 text-[0.8125rem] font-medium text-[var(--foreground)] hover:bg-[var(--neutral-50)]"
    >
      <FileDown size={16} aria-hidden="true" />
      Template
    </a>
  );
}

export function RegisterActions({ projects, projectId }: { projects: ProjectOption[]; projectId: string | null }) {
  return (
    <>
      <TemplateLink />
      {projectId && projects.length > 0 && <ProjectPicker projects={projects} value={projectId} />}
      <Button variant="primary" href="/freeze-protection?new=project">
        <Plus size={16} aria-hidden="true" />
        New project
      </Button>
    </>
  );
}

type UnitOption = { id: string; name: string };

export function ReportActions({
  projects,
  projectId,
  units,
  unitId,
  fileName,
}: {
  projects: ProjectOption[];
  projectId: string | null;
  units: UnitOption[];
  /** Null means the entire project. */
  unitId: string | null;
  /** Null when there is no report to save. */
  fileName: string | null;
}) {
  return (
    <>
      {projectId && projects.length > 0 && <ProjectPicker projects={projects} value={projectId} />}
      {projectId && units.length > 0 && <ReportScope projectId={projectId} units={units} unitId={unitId} />}
      <Button onClick={() => window.print()} disabled={fileName === null}>
        <Printer size={16} aria-hidden="true" />
        Print
      </Button>
      <Button variant="primary" onClick={() => fileName && downloadReport(fileName)} disabled={fileName === null}>
        <Download size={16} aria-hidden="true" />
        Download
      </Button>
    </>
  );
}

/** The entire project, or one unit with its full record and history. Rewrites `?equipment=`. */
function ReportScope({ projectId, units, unitId }: { projectId: string; units: UnitOption[]; unitId: string | null }) {
  const router = useRouter();
  const base = `/freeze-protection/report?project=${encodeURIComponent(projectId)}`;
  return (
    <label className="flex items-center gap-2">
      <span className="eyebrow text-[var(--muted)]">Report on</span>
      <select
        value={unitId ?? ""}
        onChange={(e) => router.push(e.target.value ? `${base}&equipment=${encodeURIComponent(e.target.value)}` : base)}
        className="h-9 max-w-[14rem] truncate rounded-[var(--radius-control)] border border-[var(--border)] bg-white px-3 text-[0.8125rem]"
      >
        <option value="">Entire project</option>
        {units.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Saves the report as one self-contained HTML file to send or file, as the
 * original sheet did. The page's own stylesheets are inlined (same origin, so
 * readable), controls are dropped and inputs become their values, so the file
 * reads the same with no platform behind it. Print to PDF is the other route.
 */
function downloadReport(fileName: string) {
  const source = document.getElementById(REPORT_ID);
  if (!source) return;
  const doc = source.cloneNode(true) as HTMLElement;
  doc.querySelectorAll("[data-no-print], button").forEach((n) => n.remove());
  // React sets an input's value as a property, which cloning does not copy, so
  // values are read from the live inputs. Both lists are taken before any change.
  const copies = Array.from(doc.querySelectorAll("input, textarea"));
  source.querySelectorAll("input, textarea").forEach((input, i) => {
    const copy = copies[i];
    if (!copy) return;
    const span = document.createElement("span");
    span.className = "font-mono";
    span.textContent = (input as HTMLInputElement).value || "—";
    copy.replaceWith(span);
  });
  const css = Array.from(document.styleSheets)
    .map((sheet) => {
      try {
        return Array.from(sheet.cssRules, (r) => r.cssText).join("\n");
      } catch {
        return "";
      }
    })
    .join("\n");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${fileName}</title><style>${css}</style>
<style>body{background:#fff;margin:0;padding:32px}#${REPORT_ID}{max-width:60rem;margin:0 auto}</style></head><body>${doc.outerHTML}</body></html>`;
  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
