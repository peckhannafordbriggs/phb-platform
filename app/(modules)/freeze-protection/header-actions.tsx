"use client";

import { usePathname, useRouter } from "next/navigation";
import { Download, Plus, Printer } from "lucide-react";
import { Button } from "./ui/Button";

type ProjectOption = { id: string; name: string };

/** Which project Register and Report show. Changing it rewrites `?project=` on the current tab. */
export function ProjectPicker({ projects, value }: { projects: ProjectOption[]; value: string }) {
  const router = useRouter();
  const pathname = usePathname();
  return (
    <label className="flex items-center gap-2">
      <span className="eyebrow text-[var(--muted)]">Project</span>
      <select
        value={value}
        onChange={(e) => router.push(`${pathname}?project=${encodeURIComponent(e.target.value)}`)}
        className="h-9 max-w-[18rem] truncate rounded-[var(--radius-control)] border border-[var(--border)] bg-white px-3 text-[0.8125rem]"
      >
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export function RegisterActions({ projects, projectId }: { projects: ProjectOption[]; projectId: string }) {
  return (
    <>
      <ProjectPicker projects={projects} value={projectId} />
      <Button variant="primary" href={`/freeze-protection?project=${encodeURIComponent(projectId)}&new=1`}>
        <Plus size={16} aria-hidden="true" />
        Add equipment
      </Button>
    </>
  );
}

export function ReportActions({ projects, projectId }: { projects: ProjectOption[]; projectId: string }) {
  return (
    <>
      <ProjectPicker projects={projects} value={projectId} />
      <Button onClick={() => window.print()}>
        <Printer size={16} aria-hidden="true" />
        Print
      </Button>
      {/* Phase 2: the standalone report file. */}
      <Button variant="primary" disabled>
        <Download size={16} aria-hidden="true" />
        Download
      </Button>
    </>
  );
}
