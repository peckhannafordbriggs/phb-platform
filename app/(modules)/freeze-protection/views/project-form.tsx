"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Plus, X } from "lucide-react";
import type { FpProject } from "@/lib/modules/freeze-protection/types";
import { call } from "../client";
import { FieldLabel, INPUT } from "../ui/Field";
import { Button, Card, Label } from "../ui/kit";

/** A new project: job number, name, and its buildings (at least one). Opened by `?new=project`. */
export function ProjectForm({ cancelHref }: { cancelHref: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [jobNumber, setJobNumber] = useState("");
  const [name, setName] = useState("");
  const [buildings, setBuildings] = useState<string[]>([""]);
  const [error, setError] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const named = buildings.map((b) => b.trim()).filter(Boolean);
    startTransition(async () => {
      const r = await call<FpProject>("POST", "/projects", {
        jobNumber,
        name,
        buildings: named.length > 0 ? named : ["Main"],
      });
      if (!r.ok) return setError(r.message);
      router.push(`/freeze-protection?project=${r.data.id}`);
      router.refresh();
    });
  }

  return (
    <Card className="mx-auto w-full max-w-xl">
      <Label>New project</Label>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
          <FieldLabel label="Job number">
            <input required value={jobNumber} onChange={(e) => setJobNumber(e.target.value)} className={INPUT + " font-mono"} placeholder="26-104A" />
          </FieldLabel>
          <FieldLabel label="Project name">
            <input required value={name} onChange={(e) => setName(e.target.value)} className={INPUT} />
          </FieldLabel>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-[0.75rem] text-[var(--muted)]">Buildings. A single-building job needs one; leave it blank for &ldquo;Main&rdquo;.</span>
          {buildings.map((b, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                value={b}
                aria-label={`Building ${i + 1}`}
                placeholder={i === 0 ? "Main" : "Building name"}
                onChange={(e) => setBuildings(buildings.map((x, j) => (j === i ? e.target.value : x)))}
                className={INPUT}
              />
              {buildings.length > 1 && (
                <button
                  type="button"
                  aria-label={`Remove building ${i + 1}`}
                  onClick={() => setBuildings(buildings.filter((_, j) => j !== i))}
                  className="shrink-0 text-[var(--muted)] hover:text-[var(--foreground)]"
                >
                  <X size={16} />
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            onClick={() => setBuildings([...buildings, ""])}
            className="inline-flex w-fit items-center gap-1 text-[0.8125rem] text-[var(--muted)] hover:text-[var(--foreground)]"
          >
            <Plus size={14} aria-hidden="true" /> Another building
          </button>
        </div>

        {error && <p className="text-[0.8125rem] text-[var(--phb-maroon)]">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button href={cancelHref}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={pending}>
            Create project
          </Button>
        </div>
      </form>
    </Card>
  );
}
