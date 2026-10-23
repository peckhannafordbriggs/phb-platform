"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { FpProject } from "@/lib/modules/freeze-protection/types";
import { call } from "../client";
import { FieldLabel, INPUT } from "../ui/Field";
import { Button, Card, Label } from "../ui/kit";

/** A new project: job number, name, and the date its verification speaks for. Opened by `?new=project`. */
export function ProjectForm({ cancelHref, today }: { cancelHref: string; today: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [jobNumber, setJobNumber] = useState("");
  const [name, setName] = useState("");
  const [verificationDate, setVerificationDate] = useState(today);
  const [error, setError] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const r = await call<FpProject>("POST", "/projects", { jobNumber, name, verificationDate });
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
          <FieldLabel label="Verification date">
            <input type="date" required value={verificationDate} onChange={(e) => setVerificationDate(e.target.value)} className={INPUT + " font-mono"} />
          </FieldLabel>
        </div>
        <p className="text-[0.75rem] text-[var(--muted)]">The report speaks for this date. You can change it later.</p>

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
