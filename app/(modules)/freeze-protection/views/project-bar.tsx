"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Pencil, Plus, X } from "lucide-react";
import { funnel } from "@/lib/modules/freeze-protection/disposition";
import type { FpLine, FpProject, FpVerification } from "@/lib/modules/freeze-protection/types";
import { call } from "../client";
import { INPUT, TextField } from "../ui/Field";
import { Button, Card, Funnel } from "../ui/kit";

/** How a round reads in the picker: its date and how far its signoff has got. */
function roundLabel(v: FpVerification) {
  const state = v.reviewed ? (v.changedAfterReview ? "changed after review" : "reviewed") : v.completed ? "completed" : "open";
  return `${v.verificationDate} · ${state}`;
}

/**
 * The project's header on the Register: job number and name, which
 * verification round is showing (and starting a new one), and the funnel for
 * whatever the table is showing. The pencil opens Edit project, which is also
 * where buildings are renamed and removed.
 */
export function ProjectBar({
  project,
  verifications,
  verification,
  lines,
  today,
}: {
  project: FpProject;
  verifications: FpVerification[];
  verification: FpVerification | null;
  /** The lines the table is showing, so the funnel follows the building switcher. */
  lines: FpLine[];
  today: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [startingRound, setStartingRound] = useState(false);
  const [roundDate, setRoundDate] = useState(today);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const base = `/freeze-protection?project=${encodeURIComponent(project.id)}`;
  const unitCount = project.buildings.reduce((n, b) => n + b.equipmentCount, 0);

  /** Runs a write; the server's sentence is shown if it refuses. Always re-renders from the database. */
  const run = (fn: () => Promise<string | null>) => {
    setError(null);
    startTransition(async () => {
      const message = await fn();
      if (message) setError(message);
      router.refresh();
    });
  };
  const write = (method: "PATCH" | "DELETE", path: string, body?: unknown) =>
    run(async () => {
      const r = await call(method, path, body);
      return r.ok ? null : r.message;
    });

  const startRound = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      const r = await call<FpVerification>("POST", `/projects/${project.id}/verifications`, { verificationDate: roundDate });
      if (!r.ok) return r.message;
      setStartingRound(false);
      router.push(`${base}&round=${r.data.id}`, { scroll: false });
      return null;
    });
  };
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
          <div key={`${project.jobNumber}-${project.name}`} className="grid min-w-0 flex-1 grid-cols-1 gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
            <TextField label="Job number" value={project.jobNumber} onSave={(v) => v && write("PATCH", `/projects/${project.id}`, { jobNumber: v })} mono />
            <TextField label="Project name" value={project.name} onSave={(v) => v && write("PATCH", `/projects/${project.id}`, { name: v })} />
          </div>
          <Button onClick={() => setEditing(false)}>Done</Button>
        </div>

        <p className="eyebrow mb-2 mt-5 text-[var(--muted)]">Buildings</p>
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {project.buildings.map((b) => (
            <li key={`${b.id}-${b.name}`} className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <TextField
                  label={`${b.equipmentCount} unit${b.equipmentCount === 1 ? "" : "s"}`}
                  value={b.name}
                  onSave={(v) => v && write("PATCH", `/buildings/${b.id}`, { name: v })}
                />
              </div>
              {project.buildings.length > 1 && (
                <button
                  type="button"
                  aria-label={`Remove building ${b.name}`}
                  title={b.equipmentCount > 0 ? "Move or remove its units first" : "Remove building"}
                  onClick={() => write("DELETE", `/buildings/${b.id}`)}
                  className="mb-2 shrink-0 text-[var(--muted)] hover:text-[var(--phb-maroon)]"
                >
                  <X size={16} />
                </button>
              )}
            </li>
          ))}
        </ul>

        {error && <p className="mt-3 text-[0.8125rem] text-[var(--phb-maroon)]">{error}</p>}
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-[var(--divider-soft)] pt-3 text-[0.75rem] text-[var(--muted)]">
          {confirmDelete ? (
            <>
              <span>
                Delete job {project.jobNumber} with its {project.buildings.length} building{project.buildings.length === 1 ? "" : "s"}, {unitCount}{" "}
                unit{unitCount === 1 ? "" : "s"} and {verifications.length} verification{verifications.length === 1 ? "" : "s"}? The audit log keeps a
                record.
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
            title="Edit project and buildings"
            onClick={() => setEditing(true)}
            className="shrink-0 text-[var(--muted)] hover:text-[var(--foreground)]"
          >
            <Pencil size={14} />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {startingRound ? (
            <form onSubmit={startRound} className="flex items-center gap-2">
              <label className="flex items-center gap-2">
                <span className="text-[0.75rem] text-[var(--muted)]">Verification date</span>
                <input type="date" required value={roundDate} onChange={(e) => setRoundDate(e.target.value)} className={INPUT + " w-40 font-mono"} />
              </label>
              <Button type="submit" variant="primary" disabled={pending}>
                Start
              </Button>
              <Button onClick={() => setStartingRound(false)}>Cancel</Button>
            </form>
          ) : (
            <>
              {verifications.length > 0 && (
                <label className="flex items-center gap-2">
                  <span className="eyebrow text-[var(--muted)]">Verification</span>
                  <select
                    value={verification?.id ?? ""}
                    onChange={(e) => router.push(`${base}&round=${e.target.value}`, { scroll: false })}
                    className={INPUT + " w-auto font-mono"}
                  >
                    {verifications.map((v) => (
                      <option key={v.id} value={v.id}>
                        {roundLabel(v)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <Button onClick={() => setStartingRound(true)}>
                <Plus size={16} aria-hidden="true" />
                New verification
              </Button>
            </>
          )}
        </div>
      </div>

      {error && <p className="mt-3 text-[0.8125rem] text-[var(--phb-maroon)]">{error}</p>}

      <div className="mt-4">
        {verification ? (
          <Funnel stages={funnel(lines)} />
        ) : (
          <p className="text-[0.8125rem] text-[var(--muted)]">
            {unitCount === 0
              ? "No equipment yet. Add each building's units from its mechanical equipment schedule, then start a verification."
              : `${unitCount} unit${unitCount === 1 ? "" : "s"} on the schedule. Start a verification to record results.`}
          </p>
        )}
      </div>
    </Card>
  );
}
