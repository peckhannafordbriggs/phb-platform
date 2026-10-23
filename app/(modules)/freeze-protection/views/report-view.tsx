"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { FREEZE_SEASON } from "@/lib/modules/freeze-protection/constants";
import { disposition, funnel, toneCounts } from "@/lib/modules/freeze-protection/disposition";
import type { FpHistoryEntry, FpLine, FpProject, FpSignature } from "@/lib/modules/freeze-protection/types";
import {
  COIL_LABEL,
  CONFIRMED_WITH_LABEL,
  EXPOSURE_LABEL,
  EXPOSURE_SHORT,
  PROTECTION_LABEL,
  STATUS_LABEL,
  TESTS,
} from "@/lib/modules/freeze-protection/vocab";
import { call } from "../client";
import { DateField, TextField } from "../ui/Field";
import { Button, Callout, Card, Empty, Pill } from "../ui/kit";
import { History } from "./history";

export const REPORT_ID = "fp-report";

const LONG_DATE = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" });
const SIGNED_AT = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" });
const MONTH = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" });

/** A date-only value as words. Formatted in UTC: it is stored as midnight UTC. */
const longDate = (d: string) => LONG_DATE.format(new Date(`${d}T00:00:00Z`));
const seasonDay = ({ month, day }: { month: number; day: number }) => `${MONTH.format(new Date(Date.UTC(2000, month - 1, 1)))} ${day}`;
const COIL_SHORT = { none: "None", water: "Water", glycol: "Glycol", steam: "Steam" } as const;

/**
 * The document handed to the CM or owner: the entire project, or one unit with
 * its full record and history. Read-only except step 7 (signoff, recorded as
 * the signed-in employee) and the transmittal, which belong to the project's
 * one verification whatever the scope. Nothing locks after review; a later
 * change is flagged instead.
 */
export function ReportView({
  project,
  lines,
  unit = null,
  history = [],
}: {
  project: FpProject | null;
  lines: FpLine[];
  /** One unit, or null for the entire project. */
  unit?: FpLine | null;
  /** The unit's history, when `unit` is set. */
  history?: FpHistoryEntry[];
}) {
  if (!project) {
    return (
      <Card className="mx-auto flex w-full max-w-[60rem] flex-1">
        <Empty>No projects yet, so there is no report.</Empty>
      </Card>
    );
  }

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
              {unit && (
                <span className="text-[var(--muted)]">
                  {" "}
                  · <span className="font-mono">{unit.name}</span>
                </span>
              )}
            </h2>
            <p className="text-[var(--muted)]">Peck Hannaford + Briggs Controls Division</p>
          </header>

          <div className="flex flex-col gap-2">
            {project.changedAfterReview && (
              <Callout tone="warn" lead="Changed after review.">
                Equipment was added, changed or removed after this verification was reviewed. The procedure requires a new review and signoff.
              </Callout>
            )}
            <Callout tone="closed" lead={`Verification date ${longDate(project.verificationDate)}.`}>
              This report reflects conditions as of that date and does not cover equipment brought online afterward.
            </Callout>
            <Callout tone="open" lead="Before startup.">
              Any equipment brought online between {seasonDay(FREEZE_SEASON.start)} and {seasonDay(FREEZE_SEASON.end)} requires this verification before
              startup. The project manager is responsible, triggered by the startup notification.
            </Callout>
          </div>

          {unit ? <UnitBody unit={unit} history={history} /> : <ProjectBody lines={lines} />}

          <Signoff project={project} scoped={unit !== null} />
          <Transmittal key={`${project.transmittedTo}-${project.transmittedDate}`} project={project} />
        </article>
      </Card>
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

const TH = "eyebrow py-2 pr-3 font-semibold text-[var(--muted)]";
const TD = "py-1.5 pr-3";

// ---------------------------------------------------------------------------
// Entire project
// ---------------------------------------------------------------------------

function ProjectBody({ lines }: { lines: FpLine[] }) {
  const counts = toneCounts(lines);
  const stages = funnel(lines);
  const stage = (key: string) => stages.find((s) => s.key === key)?.count ?? 0;
  const rows = lines.map((line) => ({ line, d: disposition(line) }));
  const action = rows.filter(({ d }) => d.tone === "bad" || d.tone === "warn");
  const open = rows.filter(({ d }) => d.tone === "open");

  return (
    <>
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
          <p className="text-[var(--muted)]">No equipment listed.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem]">
              <thead>
                <tr className="border-b border-[var(--border)] text-left">
                  {["Name", "Type", "Area served", "Status", "Coil", "Outside air", "Protection", "Trip °F", "Tested", "Disposition"].map((h) => (
                    <th key={h} className={TH}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(({ line: e, d }) => (
                  <tr key={e.id} className="border-b border-[var(--divider-soft)] align-top">
                    <td className={TD + " font-mono"}>{e.name}</td>
                    <td className={TD}>{e.equipmentType ?? "—"}</td>
                    <td className={TD}>{e.areaServed ?? "—"}</td>
                    <td className={TD}>{STATUS_LABEL[e.status]}</td>
                    <td className={TD}>{e.coil ? COIL_SHORT[e.coil] : "—"}</td>
                    <td className={TD}>{e.exposure ? EXPOSURE_SHORT[e.exposure] : "—"}</td>
                    <td className={TD}>{e.protection ? PROTECTION_LABEL[e.protection] : "—"}</td>
                    <td className={TD + " font-mono"}>{e.test.tripTempF ?? "—"}</td>
                    <td className={TD + " font-mono"}>{e.test.testDate ?? "—"}</td>
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
                {["Name", "Finding", "Owner", "Due"].map((h) => (
                  <th key={h} className={TH}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {action.map(({ line: e, d }) => (
                <tr key={e.id} className="border-b border-[var(--divider-soft)] align-top">
                  <td className={TD + " font-mono"}>{e.name}</td>
                  <td className={TD}>{e.deficiency?.description ?? d.sentence}</td>
                  <td className={TD}>{e.deficiency?.owner ?? e.notification?.who ?? "—"}</td>
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
                  <td className="w-32 py-1.5 pr-3 font-mono">{e.name}</td>
                  <td className="py-1.5">{d.sentence}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// One unit
// ---------------------------------------------------------------------------

/** A label and its answer, one row. Empty answers read "Not answered". */
function Facts({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <table className="w-full">
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label} className="border-b border-[var(--divider-soft)] align-top">
            <td className="w-56 py-1.5 pr-4 text-[var(--muted)]">{label}</td>
            <td className="py-1.5">{value ?? <span className="text-[var(--muted)]">Not answered</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function UnitBody({ unit: e, history }: { unit: FpLine; history: FpHistoryEntry[] }) {
  const d = disposition(e);
  const answer = (v: "yes" | "no" | undefined) => (v === "yes" ? "Yes" : v === "no" ? "No" : null);
  const mono = (v: string | null) => (v === null ? null : <span className="font-mono">{v}</span>);

  return (
    <>
      <Section title="Disposition">
        <p className="flex flex-wrap items-center gap-2">
          <Pill tone={d.tone}>{d.label}</Pill>
          <span>{d.sentence}</span>
        </p>
      </Section>

      <Section title="Equipment">
        <Facts
          rows={[
            ["Name", mono(e.name)],
            ["Equipment type", e.equipmentType],
            ["Area served", e.areaServed],
            ["Status", STATUS_LABEL[e.status]],
            ["Coil", e.coil ? COIL_LABEL[e.coil] : null],
          ]}
        />
      </Section>

      <Section title="Exposure and protection">
        <Facts
          rows={[
            ["Outside air exposure", e.exposure ? EXPOSURE_LABEL[e.exposure] : null],
            ["Protection", e.protection ? PROTECTION_LABEL[e.protection] : null],
          ]}
        />
      </Section>

      <Section title="Safety test">
        <Facts
          rows={[
            ...TESTS.map((t): [string, React.ReactNode] => [t.label, answer(e.test.answers[t.key])]),
            ["Trip temperature, °F", mono(e.test.tripTempF)],
            ["Tested by", e.test.testedBy],
            ["Test date", mono(e.test.testDate)],
            ["Elements tested", e.test.elements],
          ]}
        />
      </Section>

      {e.notification && (
        <Section title="Written notice (no protection)">
          <Facts
            rows={[
              ["Notified", e.notification.who],
              ["Date", mono(e.notification.date)],
              ["Method", e.notification.method],
              ["Response", e.notification.response],
            ]}
          />
        </Section>
      )}

      {e.deficiency && (
        <Section title="Deficiency">
          <Facts
            rows={[
              ["Deficiency", e.deficiency.description],
              ["Owner", e.deficiency.owner],
              ["Due", mono(e.deficiency.due)],
            ]}
          />
        </Section>
      )}

      {e.documentation && (
        <Section title="Documented with the owner or controls vendor">
          <Facts
            rows={[
              ["Confirmed with", e.documentation.with ? CONFIRMED_WITH_LABEL[e.documentation.with] : null],
              ["Name", e.documentation.name],
              ["Date", mono(e.documentation.date)],
              ["Method", e.documentation.method],
            ]}
          />
        </Section>
      )}

      {e.notes && (
        <Section title="Notes">
          <p className="whitespace-pre-wrap">{e.notes}</p>
        </Section>
      )}

      <Section title={`History · ${history.length}`}>
        <History entries={history} />
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Signoff and transmittal: the project's, whatever the scope
// ---------------------------------------------------------------------------

/** Runs a write, shows the server's sentence if refused, and re-renders from the database. */
function useWrite() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => ReturnType<typeof call>) => {
    setError(null);
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) setError(r.message);
      router.refresh();
    });
  };
  return { pending, error, run };
}

/** Step 7. Both signatures are the signed-in employee; the server refuses self-review with a sentence. */
function Signoff({ project: p, scoped }: { project: FpProject; scoped: boolean }) {
  const { pending, error, run } = useWrite();
  const sign = (role: "completed" | "reviewed", signed: boolean) => run(() => call("POST", `/projects/${p.id}/signoff`, { role, signed }));

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
        {scoped && " These signatures cover the whole project's verification, not only this unit."}
      </p>
      <div className="flex flex-wrap gap-4">
        {box("Verification completed by", "completed", p.completed, true)}
        {box("Reviewed and signed by", "reviewed", p.reviewed, p.completed !== null)}
      </div>
      {error && <p className="mt-2 text-[var(--phb-maroon)]">{error}</p>}
    </Section>
  );
}

function Transmittal({ project: p }: { project: FpProject }) {
  const { error, run } = useWrite();
  const save = (field: "transmittedTo" | "transmittedDate") => (value: string | null) =>
    run(() => call("PATCH", `/projects/${p.id}`, { [field]: value }));
  return (
    <Section title="Transmittal">
      <div className="grid max-w-xl grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_11rem]">
        <TextField label="Transmitted to CM or owner" value={p.transmittedTo} onSave={save("transmittedTo")} />
        <DateField label="Transmittal date" value={p.transmittedDate} onSave={save("transmittedDate")} />
      </div>
      {error && <p className="mt-2 text-[var(--phb-maroon)]">{error}</p>}
    </Section>
  );
}
