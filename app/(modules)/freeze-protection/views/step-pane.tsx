"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { disposition, visibleSteps } from "@/lib/modules/freeze-protection/disposition";
import type { FpHistoryEntry, FpLine } from "@/lib/modules/freeze-protection/types";
import {
  COIL_LABEL,
  CONFIRMED_WITH_LABEL,
  EXPOSURE_LABEL,
  PROTECTION_LABEL,
  STATUS_LABEL,
  STEP_OWNER,
  TESTS,
} from "@/lib/modules/freeze-protection/vocab";
import { call } from "../client";
import { DateField, NumberField, SelectField, TextArea, TextField, YesNo } from "../ui/Field";
import { Button, Callout, Pill } from "../ui/kit";
import { History } from "./history";

const options = <T extends string>(labels: Record<T, string>) =>
  (Object.keys(labels) as T[]).map((value) => ({ value, label: labels[value] }));

const TEST_FIELD = {
  fanStops: "testFanStops",
  damperCloses: "testDamperCloses",
  valveFullFlow: "testValveFullFlow",
  manualReset: "testManualReset",
} as const;

const SAVED_AT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "America/New_York",
});

/**
 * One unit: the sheet's procedure, step by step, showing only the steps the
 * answers so far lead to (`visibleSteps`, the same branching as
 * `disposition`), then the unit's history. Every field saves to the unit as it
 * changes and the page re-renders from the database.
 */
export function StepPane({ line: e, history }: { line: FpLine; history: FpHistoryEntry[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const d = disposition(e);
  const show = visibleSteps(e);

  const save = (field: string) => (value: unknown) => {
    setError(null);
    startTransition(async () => {
      const r = await call("PATCH", `/equipment/${e.id}`, { [field]: value });
      if (!r.ok) setError(r.message);
      router.refresh();
    });
  };

  function remove() {
    setError(null);
    startTransition(async () => {
      const r = await call("DELETE", `/equipment/${e.id}`);
      if (!r.ok) return setError(r.message);
      const url = new URL(window.location.href);
      url.searchParams.delete("equipment");
      router.push(url.pathname + url.search, { scroll: false });
      router.refresh();
    });
  }

  const heading = (n: number, title: string) => (
    <div className="mb-3 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="rounded border border-[var(--border)] px-1.5 font-mono text-[0.6875rem] font-medium text-[var(--muted)]">{n}</span>
      <h4 className="text-[0.8125rem] font-semibold">{title}</h4>
      {STEP_OWNER[n] && <span className="text-[0.75rem] text-[var(--muted)]">{STEP_OWNER[n]}</span>}
    </div>
  );
  const section = "border-b border-[var(--divider-soft)] pb-5 last:border-b-0";
  const grid = "grid grid-cols-1 gap-3 sm:grid-cols-2";

  return (
    <>
      <div className="shrink-0 border-b border-[var(--divider-soft)] p-5">
        <div className="flex items-center justify-between gap-3">
          <h3 className="truncate font-mono text-[0.9375rem] font-medium">{e.name}</h3>
          <Pill tone={d.tone}>{d.label}</Pill>
        </div>
        <p className="mt-1 text-[0.8125rem] text-[var(--muted)]">{d.sentence}</p>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-5">
        <section className={section}>
          {heading(1, "Equipment and status")}
          <div className={grid}>
            <TextField label="Name" value={e.name} onSave={(v) => v !== null && save("name")(v)} mono />
            <TextField label="Equipment type (optional)" value={e.equipmentType} onSave={save("equipmentType")} placeholder="AHU, RTU, MAU…" />
            <TextField label="Area served (optional)" value={e.areaServed} onSave={save("areaServed")} />
            <SelectField label="Status" value={e.status} options={options(STATUS_LABEL)} onSave={(v) => v !== null && save("status")(v)} required />
          </div>
        </section>

        <section className={section}>
          {heading(2, "Coil type")}
          <SelectField label="Water, glycol or steam coil" value={e.coil} options={options(COIL_LABEL)} onSave={save("coil")} wide />
        </section>

        {e.coil === "none" && (
          <Callout tone="closed" lead="Closed.">
            No water, glycol or steam coil, so there is nothing to freeze. The line stays in the register as part of the complete record.
          </Callout>
        )}

        {show.exposure && (
          <section className={section}>
            {heading(3, "Outside air exposure")}
            <p className="mb-3 text-[0.8125rem] text-[var(--muted)]">
              Outside air intake, mixed air, 100 percent outside air, relief or exhaust that can draw air through a closed damper, or a coil in an
              unconditioned space.
            </p>
            <SelectField label="Could outside air expose this coil to freezing?" value={e.exposure} options={options(EXPOSURE_LABEL)} onSave={save("exposure")} wide />
          </section>
        )}
        {e.exposure === "no" && show.exposure && <Callout tone="closed" lead="Closed.">No outside air element reaches this coil.</Callout>}
        {e.exposure === "unknown" && show.exposure && (
          <Callout tone="warn" lead="Unresolved.">
            Exposure has to be answered before this line can close. Walk the unit or review the airflow arrangement with the engineer.
          </Callout>
        )}

        {show.protection && (
          <section className={section}>
            {heading(4, "Protection in place")}
            <SelectField label="How is the coil protected?" value={e.protection} options={options(PROTECTION_LABEL)} onSave={save("protection")} wide />
          </section>
        )}

        {show.notify && (
          <section className={section}>
            <Callout tone="bad" lead="Stop.">
              Notify the owner or controls vendor in writing before any further work on this unit. Record the notice here.
            </Callout>
            <div className={grid + " mt-3"}>
              <TextField label="Notified" value={e.notification?.who ?? null} onSave={save("notifyWho")} />
              <DateField label="Date" value={e.notification?.date ?? null} onSave={save("notifyDate")} />
              <TextField label="Method" value={e.notification?.method ?? null} onSave={save("notifyMethod")} placeholder="Letter, email…" wide />
              <TextArea label="Response" value={e.notification?.response ?? null} onSave={save("notifyResponse")} />
            </div>
          </section>
        )}

        {d.code === "deferred" && (
          <Callout tone="open" lead="Test deferred.">
            Exposure and protection are recorded. The safety has to be tested before the system is filled and placed in service.
          </Callout>
        )}

        {show.test && (
          <section className={section}>
            {heading(5, "Test the safety")}
            <p className="mb-2 text-[0.8125rem] text-[var(--muted)]">
              With the fan running and the outside air damper open, apply ice water or spray to the sensing element. Test each element separately
              where more than one is wired in series.
            </p>
            <div className="mb-3">
              {TESTS.map((t) => (
                <YesNo key={t.key} label={t.label} value={e.test.answers[t.key]} onSave={save(TEST_FIELD[t.key])} />
              ))}
            </div>
            <div className={grid}>
              <NumberField label="Trip temperature, °F" value={e.test.tripTempF} onSave={save("tripTempF")} />
              <TextField label="Tested by" value={e.test.testedBy} onSave={save("testedBy")} />
              <DateField label="Test date" value={e.test.testDate} onSave={save("testDate")} />
              <TextField label="Elements tested" value={e.test.elements} onSave={save("elements")} />
            </div>
          </section>
        )}

        {show.deficiency && (
          <section className={section}>
            <Callout tone={d.tone} lead="Deficiency.">
              {d.sentence} Assign an owner and a date.
            </Callout>
            <div className={grid + " mt-3"}>
              <TextArea label="Deficiency" value={e.deficiency?.description ?? null} onSave={save("deficiencyDescription")} />
              <TextField label="Owner" value={e.deficiency?.owner ?? null} onSave={save("deficiencyOwner")} />
              <DateField label="Due" value={e.deficiency?.due ?? null} onSave={save("deficiencyDue")} />
            </div>
          </section>
        )}

        {show.documentation && (
          <section className={section}>
            {heading(6, "Documented with the owner or controls vendor")}
            <div className={grid}>
              <SelectField label="Confirmed with" value={e.documentation?.with ?? null} options={options(CONFIRMED_WITH_LABEL)} onSave={save("documentedWith")} />
              <TextField label="Name" value={e.documentation?.name ?? null} onSave={save("documentedName")} />
              <DateField label="Date" value={e.documentation?.date ?? null} onSave={save("documentedDate")} />
              <TextField label="Method" value={e.documentation?.method ?? null} onSave={save("documentedMethod")} />
            </div>
          </section>
        )}

        <section className={section}>
          <TextArea label="Notes" value={e.notes} onSave={save("notes")} />
        </section>

        <section>
          <h4 className="mb-2 text-[0.8125rem] font-semibold">History</h4>
          <History entries={history} />
        </section>
      </div>

      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-[var(--divider-soft)] px-5 py-3">
        <p className="text-[0.75rem] text-[var(--muted)]" role="status" aria-live="polite">
          {error ? (
            <span className="text-[var(--phb-maroon)]">{error}</span>
          ) : pending ? (
            "Saving…"
          ) : (
            <>
              Last change {SAVED_AT.format(new Date(e.updatedAt))}
              {e.updatedBy ? ` by ${e.updatedBy}` : ""}
            </>
          )}
        </p>
        {confirmRemove ? (
          <div className="flex items-center gap-2">
            <span className="text-[0.75rem]">Remove {e.name} and its results? Its history stays in the audit log.</span>
            <Button onClick={remove} disabled={pending}>
              Remove
            </Button>
            <Button onClick={() => setConfirmRemove(false)}>Keep</Button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmRemove(true)}
            className="inline-flex items-center gap-1.5 text-[0.75rem] text-[var(--muted)] hover:text-[var(--phb-maroon)]"
          >
            <Trash2 size={13} aria-hidden="true" />
            Remove from register
          </button>
        )}
      </div>
    </>
  );
}
