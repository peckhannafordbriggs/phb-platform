"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Pencil } from "lucide-react";
import { funnel } from "@/lib/modules/freeze-protection/disposition";
import type { FpLine, FpProject } from "@/lib/modules/freeze-protection/types";
import { call } from "../client";
import { DateField, TextField } from "../ui/Field";
import { Button, Card, Funnel, Pill } from "../ui/kit";

/** Where the step 7 signoff stands, in words. Signing happens on the Report. */
function signoffState(p: FpProject) {
  if (p.reviewed) return p.changedAfterReview ? { tone: "warn" as const, label: "Changed after review" } : { tone: "ok" as const, label: "Reviewed" };
  if (p.completed) return { tone: "open" as const, label: "Completed, awaiting review" };
  return { tone: "closed" as const, label: "Not signed" };
}

/**
 * The project's header on the Register: job number and name, its verification
 * date and where the signoff stands, and the funnel. The pencil opens Edit
 * project (job number, name, verification date, delete).
 */
export function ProjectBar({ project, lines }: { project: FpProject; lines: FpLine[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const state = signoffState(project);

  const run = (fn: () => Promise<string | null>) => {
    setError(null);
    startTransition(async () => {
      const message = await fn();
      if (message) setError(message);
      router.refresh();
    });
  };
  const save = (field: "jobNumber" | "name" | "verificationDate") => (value: string | null) =>
    value &&
    run(async () => {
      const r = await call("PATCH", `/projects/${project.id}`, { [field]: value });
      return r.ok ? null : r.message;
    });
  const deleteProject = () =>
    run(async () => {
      const r = await call("DELETE", `/projects/${project.id}`);
      if (!r.ok) return r.message;
      router.push("/freeze-protection");
      return null;
    });

  if (editing) {
    return (
      <Card className="shrink-0">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div
            key={`${project.jobNumber}-${project.name}-${project.verificationDate}`}
            className="grid min-w-0 flex-1 grid-cols-1 gap-3 sm:grid-cols-[10rem_minmax(0,1fr)_11rem]"
          >
            <TextField label="Job number" value={project.jobNumber} onSave={save("jobNumber")} mono />
            <TextField label="Project name" value={project.name} onSave={save("name")} />
            <DateField label="Verification date" value={project.verificationDate} onSave={save("verificationDate")} />
          </div>
          <Button onClick={() => setEditing(false)}>Done</Button>
        </div>
        {error && <p className="mt-3 text-[0.8125rem] text-[var(--phb-maroon)]">{error}</p>}
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-[var(--divider-soft)] pt-3 text-[0.75rem] text-[var(--muted)]">
          {confirmDelete ? (
            <>
              <span>
                Delete job {project.jobNumber} and its {project.equipmentCount} unit{project.equipmentCount === 1 ? "" : "s"}? The audit log keeps
                their history.
              </span>
              <Button onClick={deleteProject} disabled={pending}>
                Delete project
              </Button>
              <Button onClick={() => setConfirmDelete(false)}>Keep</Button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirmDelete(true)} className="hover:text-[var(--phb-maroon)]">
              Delete this project
            </button>
          )}
        </div>
      </Card>
    );
  }

  return (
    <Card className="shrink-0">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-base font-semibold">
            <span className="font-mono">{project.jobNumber}</span> <span className="text-[var(--muted)]">·</span> {project.name}
          </h2>
          <button
            type="button"
            aria-label="Edit project"
            title="Edit project"
            onClick={() => setEditing(true)}
            className="shrink-0 text-[var(--muted)] hover:text-[var(--foreground)]"
          >
            <Pencil size={14} />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[0.8125rem] text-[var(--muted)]">
          <span>
            Verification date <span className="font-mono text-[var(--foreground)]">{project.verificationDate}</span>
          </span>
          <Pill tone={state.tone}>{state.label}</Pill>
        </div>
      </div>

      {error && <p className="mt-3 text-[0.8125rem] text-[var(--phb-maroon)]">{error}</p>}

      <div className="mt-4">
        {lines.length > 0 ? (
          <Funnel stages={funnel(lines)} />
        ) : (
          <p className="text-[0.8125rem] text-[var(--muted)]">
            No equipment yet. Add each unit from the mechanical equipment schedule, including units not yet installed and systems not yet filled.
          </p>
        )}
      </div>
    </Card>
  );
}
