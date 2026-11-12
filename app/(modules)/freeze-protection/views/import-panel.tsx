"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { FileDown, FileUp } from "lucide-react";
import type { FormDifference, FormImportOutcome } from "@/lib/modules/freeze-protection/import/form-commit";
import type { ParsedForm } from "@/lib/modules/freeze-protection/import/form";
import { mergeSchedules } from "@/lib/modules/freeze-protection/import/merge";
import { selectForImport } from "@/lib/modules/freeze-protection/import/select";
import type { AnalyzedSchedule, ScheduleBlock } from "@/lib/modules/freeze-protection/import/types";
import { call, upload } from "../client";
import { Button, Callout, Card, Label } from "../ui/kit";
import { clearHandOff, pendingFile } from "./import-handoff";

/**
 * The import, straight into the equipment list: no review page. One file
 * picker takes either kind of PDF, and /import/split says which it is.
 *
 * An equipment schedule (a drawing set):
 * 1. /import/split cuts it into schedules (no model).
 * 2. Each schedule goes to /import/analyze, three at a time, so progress shows
 *    and no one request runs long. A schedule that fails is listed and skipped;
 *    a missing key stops the run with the server's sentence.
 * 3. The units on equipment schedules whose names were found in the PDF go to
 *    /import/commit (selectForImport). Names already in the list are never
 *    touched.
 *
 * A filled verification form (form.ts):
 * 1. /import/split recognises its hidden marker field and returns its rows.
 * 2. The rows go to POST /import/form: new names are added, blank fields on
 *    units already in the list are filled, and anything the form disagrees
 *    with is kept as it is and listed as a difference.
 *
 * Either way the list refreshes behind this panel, and the panel says what was
 * added and what was left out.
 *
 * Shown above the equipment list (`?new=import`). From New project, the file is
 * handed over (import-handoff.ts) and the run starts on its own.
 */

const PARALLEL = 3;
const FORM_URL = "/api/modules/freeze-protection/import/form";

export type ImportFailure = { title: string; message: string };

export interface ImportResult {
  fileName: string;
  created: number;
  notEquipment: number;
  noCoil: number;
  notExposed: number;
  existing: string[];
  notFound: string[];
  warnings: string[];
  failures: ImportFailure[];
}

export interface FormResult extends FormImportOutcome {
  fileName: string;
  /** What the form itself had wrong (a row with no name, a value not on the list). */
  problems: string[];
}

type Read =
  | { kind: "schedule"; fileName: string; schedules: ScheduleBlock[] }
  | { kind: "form"; fileName: string; form: ParsedForm };

type Phase =
  | { kind: "pick"; error?: string }
  | { kind: "splitting" }
  | { kind: "reading"; done: number; total: number; current: string }
  | { kind: "saving"; what: "units" | "form" }
  | { kind: "done"; result: ImportResult }
  | { kind: "formDone"; result: FormResult };

export function ImportPanel({ projectId, existingNames, doneHref }: { projectId: string; existingNames: string[]; doneHref: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: "pick" });
  const [file, setFile] = useState<File | null>(null);
  const abort = useRef<AbortController | null>(null);

  async function run(pdf: File) {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    // A run that was stopped or replaced (Stop, leaving the page, React's
    // development double mount) must not touch the screen any more.
    const live = () => abort.current === controller && !controller.signal.aborted;
    setPhase({ kind: "splitting" });

    const form = new FormData();
    form.set("file", pdf);
    const cut = await upload<Read>("/import/split", form, controller.signal);
    if (!live()) return;
    clearHandOff();
    if (!cut.ok) return setPhase({ kind: "pick", error: cut.message });

    if (cut.data.kind === "form") return runForm(cut.data.fileName, cut.data.form, controller.signal, live);

    const blocks = cut.data.schedules;
    const read: (AnalyzedSchedule | null)[] = blocks.map(() => null);
    const failures: ImportFailure[] = [];
    let next = 0;
    let done = 0;
    let fatal: string | null = null;
    setPhase({ kind: "reading", done: 0, total: blocks.length, current: blocks[0]?.title ?? "" });

    const worker = async () => {
      while (fatal === null && !controller.signal.aborted && next < blocks.length) {
        const i = next++;
        const block = blocks[i]!;
        const r = await call<AnalyzedSchedule>("POST", "/import/analyze", block, controller.signal);
        if (r.ok) read[i] = r.data;
        else if (r.code === "not_configured") fatal = r.message;
        else if (r.code !== "aborted") failures.push({ title: block.part ? `${block.title} (${block.part})` : block.title, message: r.message });
        done++;
        if (live()) setPhase({ kind: "reading", done, total: blocks.length, current: blocks[Math.min(next, blocks.length - 1)]?.title ?? "" });
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, blocks.length) }, worker));
    if (!live()) return;
    if (fatal !== null) return setPhase({ kind: "pick", error: fatal });

    const schedules = read.filter((s): s is AnalyzedSchedule => s !== null);
    const chosen = selectForImport(mergeSchedules(schedules), existingNames);
    const result: ImportResult = {
      fileName: cut.data.fileName,
      created: 0,
      notEquipment: chosen.notEquipment,
      noCoil: chosen.noCoil,
      notExposed: chosen.notExposed,
      existing: chosen.existing,
      notFound: chosen.notFound,
      warnings: schedules.filter((s) => s.isEquipment).flatMap((s) => s.warnings.map((w) => `${s.title}: ${w}`)),
      failures,
    };
    if (chosen.rows.length > 0) {
      setPhase({ kind: "saving", what: "units" });
      const saved = await call<{ created: number; skipped: string[] }>(
        "POST",
        "/import/commit",
        { projectId, fileName: cut.data.fileName, rows: chosen.rows },
        controller.signal,
      );
      if (!live()) return;
      if (!saved.ok) return setPhase({ kind: "pick", error: saved.message });
      result.created = saved.data.created;
      result.existing = [...result.existing, ...saved.data.skipped];
      router.refresh();
    }
    setPhase({ kind: "done", result });
  }

  async function runForm(fileName: string, parsed: ParsedForm, signal: AbortSignal, live: () => boolean) {
    setPhase({ kind: "saving", what: "form" });
    const saved = await call<FormImportOutcome>("POST", "/import/form", { projectId, fileName, jobNumber: parsed.jobNumber, rows: parsed.rows }, signal);
    if (!live()) return;
    if (!saved.ok) return setPhase({ kind: "pick", error: saved.message });
    router.refresh();
    setPhase({ kind: "formDone", result: { ...saved.data, fileName, problems: parsed.problems } });
  }

  // From New project with the file already chosen: start straight away.
  // Leaving the page stops whatever is in flight.
  useEffect(() => {
    const handed = pendingFile(projectId);
    if (handed) {
      setFile(handed);
      void run(handed);
    }
    return () => abort.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function stop() {
    abort.current?.abort();
    clearHandOff();
    router.push(doneHref);
  }

  if (phase.kind === "done") return <ImportSummary result={phase.result} doneHref={doneHref} />;
  if (phase.kind === "formDone") return <FormSummary result={phase.result} doneHref={doneHref} />;

  if (phase.kind === "pick") {
    return (
      <Card>
        <Label>Import</Label>
        <div className="flex flex-col gap-3">
          <p className="max-w-3xl text-[0.8125rem] text-[var(--muted)]">
            Upload an equipment schedule PDF or a filled freeze protection form. From a schedule, equipment with a water, glycol or steam coil
            that outside air can reach is added and the rest is left out. From a form, new units are added and blank answers are filled; an
            answer already here is never overwritten, and any difference is listed. A scanned PDF will not work.
          </p>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <PdfField file={file} onChange={setFile} />
            <div className="flex flex-wrap gap-2">
              <a href={FORM_URL} download className={DOWNLOAD_CLASSES}>
                <FileDown size={15} aria-hidden="true" />
                Blank form
              </a>
              <Button href={doneHref}>Cancel</Button>
              <Button variant="primary" disabled={file === null} onClick={() => file && void run(file)}>
                <FileUp size={15} aria-hidden="true" />
                Import
              </Button>
            </div>
          </div>
          {phase.error && <Callout tone="bad" lead="Not imported.">{phase.error}</Callout>}
        </div>
      </Card>
    );
  }

  const pct = phase.kind === "reading" && phase.total > 0 ? Math.round((phase.done / phase.total) * 100) : phase.kind === "saving" ? 100 : 0;
  return (
    <Card>
      <div className="flex flex-col gap-2" role="status" aria-live="polite">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[0.875rem]">
            {phase.kind === "splitting"
              ? "Reading the PDF…"
              : phase.kind === "saving"
                ? phase.what === "form"
                  ? "Saving the form's answers…"
                  : "Adding the units…"
                : `Reading schedules: ${phase.done} of ${phase.total}`}
          </p>
          {phase.kind !== "saving" && (
            <Button onClick={stop} className="h-8! px-3!">
              Stop
            </Button>
          )}
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--neutral-100)]">
          <div className="h-full bg-[var(--module-accent)] transition-[width]" style={{ width: `${pct}%` }} />
        </div>
        <p className="truncate text-[0.75rem] text-[var(--muted)]">
          {phase.kind === "reading" ? phase.current : "A full drawing set takes a few minutes; a form, a few seconds. Keep this tab open."}
        </p>
      </div>
    </Card>
  );
}

/** The secondary button's look on a plain link: the download is an API route, not a page to prefetch. */
const DOWNLOAD_CLASSES =
  "inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-[var(--radius-control)] border border-[var(--border)] bg-white px-4 text-[0.8125rem] font-medium text-[var(--foreground)] hover:bg-[var(--neutral-50)]";

/** A file input styled as the module's secondary button. Shared with New project. */
export function PdfField({
  file,
  onChange,
  label = "Equipment schedule or filled form (PDF)",
}: {
  file: File | null;
  onChange: (f: File | null) => void;
  label?: string;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[0.75rem] text-[var(--muted)]">{label}</span>
      <input
        type="file"
        accept="application/pdf,.pdf"
        onChange={(e) => onChange(e.target.files?.[0] ?? null)}
        className="max-w-full text-[0.8125rem] file:mr-3 file:h-9 file:rounded-[var(--radius-control)] file:border file:border-[var(--border)] file:bg-white file:px-3 file:text-[0.8125rem] file:font-medium hover:file:bg-[var(--neutral-50)]"
      />
      {file && <span className="sr-only">{file.name}</span>}
    </label>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What the import added and, in words, everything it left out. Exported for the view tests. */
export function ImportSummary({ result: r, doneHref }: { result: ImportResult; doneHref: string }) {
  const left: string[] = [];
  if (r.notExposed > 0) left.push(`${plural(r.notExposed, "unit")} with a coil that outside air does not reach, by the schedule (recirculating units, terminal units fed conditioned air)`);
  if (r.noCoil > 0) left.push(`${plural(r.noCoil, "unit")} with no water, glycol or steam coil (exhaust valves, fans, humidifiers, pumps, electric heat), so nothing to freeze`);
  if (r.notEquipment > 0) left.push(`${plural(r.notEquipment, "item")} on schedules that are not equipment (diffusers, grilles, valves and the like)`);
  if (r.existing.length > 0) left.push(`${plural(r.existing.length, "unit")} already in this project: ${r.existing.join(", ")}`);
  if (r.notFound.length > 0) left.push(`${plural(r.notFound.length, "name")} not found in the PDF text, so possibly misread: ${r.notFound.join(", ")}`);
  return (
    <Card>
      <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <Label>Import equipment schedule</Label>
            <p className="text-[0.875rem]">
              <strong className="font-semibold">Added {plural(r.created, "unit")} at risk of freezing</strong> from {r.fileName}. Check each one against the schedule as you
              verify it.
            </p>
          </div>
          <Button variant="primary" href={doneHref} className="h-8! px-3!">
            Done
          </Button>
        </div>
        {left.length > 0 && (
          <Callout tone="closed" lead="Left out.">
            {left.join(". ")}. Add any that belong by hand.
          </Callout>
        )}
        {r.warnings.length > 0 && (
          <Callout tone="warn" lead="Check.">
            {r.warnings.join(" ")}
          </Callout>
        )}
        {r.failures.length > 0 && (
          <Callout tone="warn" lead="Not read.">
            {plural(r.failures.length, "schedule")} could not be read, so add their units by hand: {r.failures.map((f) => `${f.title} (${f.message})`).join("; ")}
          </Callout>
        )}
      </div>
    </Card>
  );
}

/**
 * What a form import added, what it filled, and every place the form and the
 * platform disagree. Differences are the point of this card (Karthik asked for
 * them highlighted), so they get a table of their own: the platform's answer
 * was kept, and the person decides in the step pane. Exported for the view tests.
 */
export function FormSummary({ result: r, doneHref }: { result: FormResult; doneHref: string }) {
  const filledFields = r.filled.reduce((n, f) => n + f.fields.length, 0);
  const headline =
    r.created.length === 0 && r.filled.length === 0
      ? "Nothing new on the form"
      : [r.created.length > 0 && `Added ${plural(r.created.length, "unit")}`, r.filled.length > 0 && `filled ${plural(filledFields, "blank answer")} on ${plural(r.filled.length, "unit")}`]
          .filter(Boolean)
          .join(" and ");
  return (
    <Card>
      <div className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <Label>Import freeze protection form</Label>
            <p className="text-[0.875rem]">
              <strong className="font-semibold">{headline.charAt(0).toUpperCase() + headline.slice(1)}</strong> from {r.fileName}.
            </p>
          </div>
          <Button variant="primary" href={doneHref} className="h-8! px-3!">
            Done
          </Button>
        </div>

        {r.differences.length > 0 && (
          <div className="flex flex-col gap-2">
            <Callout tone="warn" lead="Different.">
              {plural(r.differences.length, "answer")} on the form {r.differences.length === 1 ? "differs" : "differ"} from what is already here. The platform&apos;s answer
              was kept. If the form is right, change it on the unit.
            </Callout>
            <DifferenceTable rows={r.differences} />
          </div>
        )}
        {r.filled.length > 0 && (
          <Callout tone="ok" lead="Filled.">
            {r.filled.map((f) => `${f.name}: ${f.fields.join(", ").toLowerCase()}`).join("; ")}.
          </Callout>
        )}
        {r.created.length > 0 && (
          <Callout tone="open" lead="Added.">
            {r.created.join(", ")}.
          </Callout>
        )}
        {r.unchanged.length > 0 && (
          <Callout tone="closed" lead="Already matched.">
            {r.unchanged.join(", ")}.
          </Callout>
        )}
        {r.problems.length > 0 && (
          <Callout tone="warn" lead="Not read.">
            {r.problems.join(" ")}
          </Callout>
        )}
      </div>
    </Card>
  );
}

/** One row per disagreement. The form's value is highlighted, in words as well as tint: "Form says". */
function DifferenceTable({ rows }: { rows: FormDifference[] }) {
  return (
    <div className="overflow-x-auto rounded-[var(--radius-control)] border border-[var(--border)]">
      <table className="w-full min-w-[34rem] border-collapse text-left text-[0.8125rem]">
        <thead className="bg-[var(--neutral-50)] text-[0.75rem] text-[var(--muted)]">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">Unit</th>
            <th scope="col" className="px-3 py-2 font-medium">Field</th>
            <th scope="col" className="px-3 py-2 font-medium">Kept (platform)</th>
            <th scope="col" className="px-3 py-2 font-medium">Form says</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d, i) => (
            <tr key={`${d.name}-${d.field}-${i}`} className="border-t border-[var(--divider-soft)]">
              <td className="px-3 py-2 font-mono text-[0.75rem]">{d.name}</td>
              <td className="px-3 py-2">{d.field}</td>
              <td className="px-3 py-2">{d.platform}</td>
              <td className="bg-[color-mix(in_srgb,var(--phb-orange)_14%,transparent)] px-3 py-2 font-medium text-[var(--phb-orange-ink)]">{d.form}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
