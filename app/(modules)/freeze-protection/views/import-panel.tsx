"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { FileUp } from "lucide-react";
import { mergeSchedules } from "@/lib/modules/freeze-protection/import/merge";
import { selectForImport } from "@/lib/modules/freeze-protection/import/select";
import type { AnalyzedSchedule, ScheduleBlock } from "@/lib/modules/freeze-protection/import/types";
import { call, upload } from "../client";
import { Button, Callout, Card, Label } from "../ui/kit";
import { clearHandOff, pendingFile } from "./import-handoff";

/**
 * The equipment schedule import, straight into the register: no review page.
 *
 * 1. The PDF goes to /import/split, which cuts it into schedules (no model).
 * 2. Each schedule goes to /import/analyze, three at a time, so progress shows
 *    and no one request runs long. A schedule that fails is listed and skipped;
 *    a missing key stops the run with the server's sentence.
 * 3. The units on equipment schedules whose names were found in the PDF go to
 *    /import/commit (selectForImport). Names already in the register are never
 *    touched. The list refreshes behind this panel, and the panel says what was
 *    added and what was left out, so anything skipped can be added by hand.
 *
 * Shown above the register (`?new=import`). From New project, the file is
 * handed over (import-handoff.ts) and the run starts on its own.
 */

const PARALLEL = 3;

export type ImportFailure = { title: string; message: string };

export interface ImportResult {
  fileName: string;
  created: number;
  notEquipment: number;
  existing: string[];
  notFound: string[];
  warnings: string[];
  failures: ImportFailure[];
}

type Phase =
  | { kind: "pick"; error?: string }
  | { kind: "splitting" }
  | { kind: "reading"; done: number; total: number; current: string }
  | { kind: "saving" }
  | { kind: "done"; result: ImportResult };

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
    const cut = await upload<{ fileName: string; schedules: ScheduleBlock[] }>("/import/split", form, controller.signal);
    if (!live()) return;
    clearHandOff();
    if (!cut.ok) return setPhase({ kind: "pick", error: cut.message });

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
      existing: chosen.existing,
      notFound: chosen.notFound,
      warnings: schedules.filter((s) => s.isEquipment).flatMap((s) => s.warnings.map((w) => `${s.title}: ${w}`)),
      failures,
    };
    if (chosen.rows.length > 0) {
      setPhase({ kind: "saving" });
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

  if (phase.kind === "pick") {
    return (
      <Card>
        <Label>Import equipment schedule</Label>
        <div className="flex flex-col gap-3">
          <p className="max-w-3xl text-[0.8125rem] text-[var(--muted)]">
            The mechanical schedule sheets as a PDF from the drawing set (with text, not a scan). Claude reads each schedule and adds every unit
            with its type, area served and coil. Units already in this project are left as they are.
          </p>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <PdfField file={file} onChange={setFile} />
            <div className="flex gap-2">
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
              ? "Finding the schedules in the PDF…"
              : phase.kind === "saving"
                ? "Adding the units…"
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
          {phase.kind === "reading" ? phase.current : "A full drawing set takes a few minutes. Keep this tab open."}
        </p>
      </div>
    </Card>
  );
}

/** A file input styled as the module's secondary button. Shared with New project. */
export function PdfField({ file, onChange, label = "Equipment schedule (PDF)" }: { file: File | null; onChange: (f: File | null) => void; label?: string }) {
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
              <strong className="font-semibold">Added {plural(r.created, "unit")}</strong> from {r.fileName}. Check each one against the schedule as you
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
