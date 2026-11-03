"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { FpProject } from "@/lib/modules/freeze-protection/types";
import { call } from "../client";
import { FieldLabel, INPUT } from "../ui/Field";
import { Button, Card, Label } from "../ui/kit";
import { handOff } from "./import-handoff";
import { PdfField } from "./import-panel";

/**
 * A new project: job number, name, the date its verification speaks for, and
 * optionally the equipment schedule PDF. With a PDF, the new project's register
 * opens with the import already running above its equipment list. Opened by
 * `?new=project`.
 */
export function ProjectForm({ cancelHref, today }: { cancelHref: string; today: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [jobNumber, setJobNumber] = useState("");
  const [name, setName] = useState("");
  const [verificationDate, setVerificationDate] = useState(today);
  const [schedule, setSchedule] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const r = await call<FpProject>("POST", "/projects", { jobNumber, name, verificationDate });
      if (!r.ok) return setError(r.message);
      if (schedule) handOff(r.data.id, schedule);
      router.push(`/freeze-protection?project=${r.data.id}${schedule ? "&new=import" : ""}`);
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
          <FieldLabel label="Verification date">
            <input type="date" required value={verificationDate} onChange={(e) => setVerificationDate(e.target.value)} className={INPUT + " font-mono"} />
          </FieldLabel>
          <PdfField file={schedule} onChange={setSchedule} label="Equipment schedule (PDF, optional)" />
        </div>
        <p className="text-[0.75rem] text-[var(--muted)]">
          The verification date is the date shown on the report. Add the equipment schedule PDF to fill in the equipment list for you.
        </p>

        {error && <p className="text-[0.8125rem] text-[var(--phb-maroon)]">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button href={cancelHref}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={pending}>
            {schedule ? "Create and import" : "Create project"}
          </Button>
        </div>
      </form>
    </Card>
  );
}
