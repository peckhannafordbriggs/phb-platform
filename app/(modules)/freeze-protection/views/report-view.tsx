"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { FREEZE_SEASON } from "@/lib/modules/freeze-protection/constants";
import { disposition, funnel, toneCounts } from "@/lib/modules/freeze-protection/disposition";
import type { FpBuilding, FpLine, FpProject, FpSignature, FpVerification } from "@/lib/modules/freeze-protection/types";
import { EXPOSURE_SHORT, PROTECTION_LABEL, STATUS_LABEL } from "@/lib/modules/freeze-protection/vocab";
import { call } from "../client";
import { DateField, TextField } from "../ui/Field";
import { Button, Callout, Card, Empty, Pill } from "../ui/kit";

export const REPORT_ID = "fp-report";

const LONG_DATE = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" });
const SIGNED_AT = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" });
const MONTH = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" });

/** A date-only value as words. Formatted in UTC: it is stored as midnight UTC. */
const longDate = (d: string) => LONG_DATE.format(new Date(`${d}T00:00:00Z`));
const seasonDay = ({ month, day }: { month: number; day: number }) => `${MONTH.format(new Date(Date.UTC(2000, month - 1, 1)))} ${day}`;
const COIL_SHORT = { none: "None", water: "Water", glycol: "Glycol", steam: "Steam" } as const;

/**
 * The document handed to the CM or owner, for one verification round, covering
 * the entire project or one building. It is read-only except step 7 (signoff,
 * recorded as the signed-in employee) and the transmittal, which belong to the
 * whole verification whatever the scope. Nothing locks after review; a later
 * change is flagged instead.
 */
export function ReportView({
  project,
  verification,
  lines,
  building = null,
}: {
  project: FpProject | null;
  verification: FpVerification | null;
  /** Every line in the round; the report narrows them to `building`. */
  lines: FpLine[];
  /** One building, or null for the entire project. */
  building?: FpBuilding | null;
}) {
  if (!project || !verification) {
    return (
      <Card className="mx-auto flex w-full max-w-[60rem] flex-1">
        <Empty>
          {project ? "No verification on this project yet. Start one on the Register." : "No projects yet, so there is no report."}
        </Empty>
      </Card>
    );
  }
  return <Report project={project} verification={verification} lines={lines} building={building} />;
}

function Report({
  project,
  verification: v,
  lines: allLines,
  building,
}: {
  project: FpProject;
  verification: FpVerification;
  lines: FpLine[];
  building: FpBuilding | null;
}) {
  const lines = building ? allLines.filter((l) => l.buildingId === building.id) : allLines;
  const counts = toneCounts(lines);
  const stages = funnel(lines);
  const stage = (key: string) => stages.find((s) => s.key === key)?.count ?? 0;
  const withDisposition = lines.map((line) => ({ line, d: disposition(line) }));
  const action = withDisposition.filter(({ d }) => d.tone === "bad" || d.tone === "warn");
  const open = withDisposition.filter(({ d }) => d.tone === "open");

  return (
    <>
      {/* Print the report alone: every other part of the page is hidden, and the
          one-screen shell's scrolling is undone so a long register paginates. */}
      <style>{`@media print {
        html, body, body * { overflow: visible !important; height: auto !important; max-height: none !important; }
        body * { visibility: hidden; }
        #${REPORT_ID}, #${REPORT_ID} * { visibility: visible; }
        #${REPORT_ID} { position: absolute; inset: 0 auto auto 0; width: 100%; box-shadow: none !important; border: 0 !important; }
        #${REPORT_ID} [data-no-print] { display: none !important; }
        #${REPORT_ID} tr { break-inside: avoid; }
      }`}</style>

      <Card padding="p-8" className="mx-auto w-full max-w-[60rem]">
        <article id={REPORT_ID} className="flex flex-col gap-7 text-[0.8125rem]">
          <header>
            <p className="eyebrow text-[var(--muted)]">Freeze protection verification</p>
            <h2 className="mt-1 text-lg font-semibold">
              <span className="font-mono">{project.jobNumber}</span> · {project.name}
              {building && <span className="text-[var(--muted)]"> · {building.name}</span>}
            </h2>
            <p className="text-[var(--muted)]">Peck Hannaford + Briggs Controls Division</p>
          </header>

          <div className="flex flex-col gap-2">
            {v.changedAfterReview && (
              <Callout tone="warn" lead="Changed after review.">
                Something in this verification changed after it was reviewed. The procedure requires a new review and signoff.
              </Callout>
            )}
            {building && (
              <Callout tone="closed" lead={`${building.name} only.`}>
                This report covers the equipment in {building.name}. The project has {project.buildings.length} buildings; the verification and its
                signoff cover all of them.
              </Callout>
            )}
            <Callout tone="closed" lead={`Verification date ${longDate(v.verificationDate)}.`}>
              This report reflects conditions as of that date and does not cover equipment brought online afterward.
            </Callout>
            <Callout tone="open" lead="Before startup.">
              Any equipment brought online between {seasonDay(FREEZE_SEASON.start)} and {seasonDay(FREEZE_SEASON.end)} requires this verification before
              startup. The project manager is responsible, triggered by the startup notification.
            </Callout>
          </div>

          <Section title="Summary">
            <table className="w-full max-w-md">
              <tbody>
                {[
                  ["Equipment listed", stage("listed")],
                  ["With a water, glycol or steam coil", stage("coil")],
                  ["Exposed to outside air", stage("exposed")],
                  ["Verified", counts.ok],
                  ["No protection or failed test", counts.bad],
                  ["Deficiencies and unresolved exposure", counts.warn],
                  ["Open items", counts.open],
                  ["Closed, nothing to protect", counts.closed],
                ].map(([label, n]) => (
                  <tr key={label} className="border-b border-[var(--divider-soft)]">
                    <td className="py-1.5 pr-4">{label}</td>
                    <td className="py-1.5 text-right font-mono">{n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          <Section title={`Equipment register · ${lines.length}`}>
            {lines.length === 0 ? (
              <p className="text-[var(--muted)]">No equipment in this verification.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[44rem]">
                  <thead>
                    <tr className="border-b border-[var(--border)] text-left">
                      {[
                        "Equipment",
                        ...(building ? [] : ["Building"]),
                        "Area served",
                        "Status",
                        "Coil",
                        "Outside air",
                        "Protection",
                        "Trip °F",
                        "Tested",
                        "Disposition",
                      ].map((h) => (
                        <th key={h} className="eyebrow py-2 pr-3 font-semibold text-[var(--muted)]">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {withDisposition.map(({ line: e, d }) => (
                      <tr key={e.id} className="border-b border-[var(--divider-soft)] align-top">
                        <td className="py-1.5 pr-3 font-mono">{e.tag}</td>
                        {!building && <td className="py-1.5 pr-3">{e.buildingName}</td>}
                        <td className="py-1.5 pr-3">{e.areaServed ?? "—"}</td>
                        <td className="py-1.5 pr-3">{STATUS_LABEL[e.status]}</td>
                        <td className="py-1.5 pr-3">{e.coil ? COIL_SHORT[e.coil] : "—"}</td>
                        <td className="py-1.5 pr-3">{e.exposure ? EXPOSURE_SHORT[e.exposure] : "—"}</td>
                        <td className="py-1.5 pr-3">{e.protection ? PROTECTION_LABEL[e.protection] : "—"}</td>
                        <td className="py-1.5 pr-3 font-mono">{e.test.tripTempF ?? "—"}</td>
                        <td className="py-1.5 pr-3 font-mono">{e.test.testDate ?? "—"}</td>
                        <td className="py-1.5">
                          <Pill tone={d.tone}>{d.label}</Pill>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          {action.length > 0 && (
            <Section title={`Items requiring action · ${action.length}`}>
              <table className="w-full">
                <thead>
                  <tr className="border-b border-[var(--border)] text-left">
                    {["Equipment", "Finding", "Owner", "Due"].map((h) => (
                      <th key={h} className="eyebrow py-2 pr-3 font-semibold text-[var(--muted)]">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {action.map(({ line: e, d }) => (
                    <tr key={e.id} className="border-b border-[var(--divider-soft)] align-top">
                      <td className="py-1.5 pr-3 font-mono">{e.tag}</td>
                      <td className="py-1.5 pr-3">{e.deficiency?.description ?? d.sentence}</td>
                      <td className="py-1.5 pr-3">{e.deficiency?.owner ?? e.notification?.who ?? "—"}</td>
                      <td className="py-1.5 font-mono">{e.deficiency?.due ?? e.notification?.date ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          )}

          {open.length > 0 && (
            <Section title={`Open items · ${open.length}`}>
              <table className="w-full">
                <tbody>
                  {open.map(({ line: e, d }) => (
                    <tr key={e.id} className="border-b border-[var(--divider-soft)] align-top">
                      <td className="w-32 py-1.5 pr-3 font-mono">{e.tag}</td>
                      <td className="py-1.5">{d.sentence}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          )}

          <Signoff verification={v} scoped={building !== null} />
          <Transmittal key={`${v.id}-${v.transmittedTo}-${v.transmittedDate}`} verification={v} />
        </article>
      </Card>

      <DeleteRound verification={v} projectId={project.id} />
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 border-b border-[var(--border)] pb-1.5 text-[0.875rem] font-semibold">{title}</h3>
      {children}
    </section>
  );
}

/** Runs a write, shows the server's sentence if refused, and re-renders from the database. */
function useWrite() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => ReturnType<typeof call>, after?: () => void) => {
    setError(null);
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) setError(r.message);
      else after?.();
      router.refresh();
    });
  };
  return { pending, error, run };
}

/** Step 7. Both signatures are the signed-in employee; the server refuses self-review with a sentence. */
function Signoff({ verification: v, scoped }: { verification: FpVerification; scoped: boolean }) {
  const { pending, error, run } = useWrite();
  const sign = (role: "completed" | "reviewed", signed: boolean) =>
    run(() => call("POST", `/verifications/${v.id}/signoff`, { role, signed }));

  const box = (title: string, role: "completed" | "reviewed", signature: FpSignature | null, canSign: boolean) => (
    <div className="flex flex-1 basis-64 flex-col gap-2 rounded-[var(--radius-row)] border border-[var(--border)] p-4">
      <h4 className="font-semibold">{title}</h4>
      {signature ? (
        <>
          <p>
            {signature.name}
            <span className="block font-mono text-[0.75rem] text-[var(--muted)]">{SIGNED_AT.format(new Date(signature.at))}</span>
          </p>
          <button
            type="button"
            data-no-print
            onClick={() => sign(role, false)}
            disabled={pending}
            className="w-fit text-[0.75rem] text-[var(--muted)] hover:text-[var(--phb-maroon)]"
          >
            Remove signature
          </button>
        </>
      ) : (
        <>
          <p className="text-[var(--muted)]">Not signed.</p>
          <span data-no-print>
            <Button onClick={() => sign(role, true)} disabled={pending || !canSign}>
              Sign as me
            </Button>
          </span>
        </>
      )}
    </div>
  );

  return (
    <Section title="Step 7 · Signoff">
      <p className="mb-3 text-[var(--muted)]">
        A PH+B engineer who did not perform steps 3 through 6 reviews this report and signs. Any later change to freeze protection logic, safety
        wiring, or a related setpoint requires a new review and signoff.
        {scoped && " These signatures cover the whole verification, every building on the project."}
      </p>
      <div className="flex flex-wrap gap-4">
        {box("Verification completed by", "completed", v.completed, true)}
        {box("Reviewed and signed by", "reviewed", v.reviewed, v.completed !== null)}
      </div>
      {error && <p className="mt-2 text-[var(--phb-maroon)]">{error}</p>}
    </Section>
  );
}

function Transmittal({ verification: v }: { verification: FpVerification }) {
  const { error, run } = useWrite();
  const save = (field: "transmittedTo" | "transmittedDate") => (value: string | null) =>
    run(() => call("PATCH", `/verifications/${v.id}`, { [field]: value }));
  return (
    <Section title="Transmittal">
      <div className="grid max-w-xl grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_11rem]">
        <TextField label="Transmitted to CM or owner" value={v.transmittedTo} onSave={save("transmittedTo")} />
        <DateField label="Transmittal date" value={v.transmittedDate} onSave={save("transmittedDate")} />
      </div>
      {error && <p className="mt-2 text-[var(--phb-maroon)]">{error}</p>}
    </Section>
  );
}

/** Outside the printed document. Removes the round and its results; the units stay on the project. */
function DeleteRound({ verification: v, projectId }: { verification: FpVerification; projectId: string }) {
  const router = useRouter();
  const { pending, error, run } = useWrite();
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="mx-auto mt-4 flex w-full max-w-[60rem] flex-wrap items-center justify-end gap-2 text-[0.75rem] text-[var(--muted)] print:hidden">
      {error && <span className="text-[var(--phb-maroon)]">{error}</span>}
      {confirm ? (
        <>
          <span>Delete the {v.verificationDate} verification and all its results? The equipment stays on the project.</span>
          <Button
            disabled={pending}
            onClick={() =>
              run(
                () => call("DELETE", `/verifications/${v.id}`),
                () => router.push(`/freeze-protection/report?project=${encodeURIComponent(projectId)}`),
              )
            }
          >
            Delete
          </Button>
          <Button onClick={() => setConfirm(false)}>Keep</Button>
        </>
      ) : (
        <button type="button" onClick={() => setConfirm(true)} className="hover:text-[var(--phb-maroon)]">
          Delete this verification
        </button>
      )}
    </div>
  );
}
