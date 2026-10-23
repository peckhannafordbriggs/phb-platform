"use client";

import { usePathname, useRouter } from "next/navigation";
import { Download, Plus, Printer } from "lucide-react";
import { Button } from "./ui/kit";
import { REPORT_ID } from "./views/report-view";

type ProjectOption = { id: string; jobNumber: string; name: string };

/** Which project Register and Report show. Changing it rewrites `?project=` and drops the round. */
export function ProjectPicker({ projects, value }: { projects: ProjectOption[]; value: string }) {
  const router = useRouter();
  const pathname = usePathname();
  return (
    <label className="flex items-center gap-2">
      <span className="eyebrow text-[var(--muted)]">Project</span>
      <select
        value={value}
        onChange={(e) => router.push(`${pathname}?project=${encodeURIComponent(e.target.value)}`)}
        className="h-9 max-w-[20rem] truncate rounded-[var(--radius-control)] border border-[var(--border)] bg-white px-3 text-[0.8125rem]"
      >
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.jobNumber} · {p.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export function RegisterActions({ projects, projectId }: { projects: ProjectOption[]; projectId: string | null }) {
  const here = projectId ? `/freeze-protection?project=${encodeURIComponent(projectId)}` : "/freeze-protection";
  return (
    <>
      {projectId && projects.length > 0 && <ProjectPicker projects={projects} value={projectId} />}
      <Button href="/freeze-protection?new=project">New project</Button>
      {projectId && (
        <Button variant="primary" href={`${here}&new=equipment`}>
          <Plus size={16} aria-hidden="true" />
          Add equipment
        </Button>
      )}
    </>
  );
}

export function ReportActions({
  projects,
  projectId,
  fileName,
}: {
  projects: ProjectOption[];
  projectId: string | null;
  /** Null when there is no report to save. */
  fileName: string | null;
}) {
  return (
    <>
      {projectId && projects.length > 0 && <ProjectPicker projects={projects} value={projectId} />}
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
