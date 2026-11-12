"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { LIBRARY_SECTIONS } from "@/lib/modules/bas/reports/library";
import { PRESET_KEYS, REPORT_PRESETS } from "@/lib/modules/bas/reports/presets";
import {
  ANALYSIS_WINDOWS,
  WINDOW_LABELS,
  computeNextRun,
  describeCadence,
  scheduleProblem,
  todayIn,
  type AnalysisWindow,
} from "@/lib/modules/bas/reports/schedule";
import {
  REPORT_STATE_LABELS,
  type LibraryQuestionView,
  type OwnerOption,
  type PersonalQuestionView,
  type ReportDetail,
  type ReportOptions,
  type ReportQuestionView,
} from "@/lib/modules/bas/reports/types";
import type { CreateReportInput, UpdateReportInput } from "@/lib/validation/bas-reports";
import { ApiError } from "./health-client";
import {
  EXTERNAL_CHIP,
  OWNER_ROW_LABEL,
  addInline,
  addRecipient,
  applyPreset,
  changeReportState,
  clearShared,
  createReport,
  deleteReport,
  describeNextRun,
  describeSelection,
  emptySelection,
  fetchLibrary,
  fetchPersonal,
  fetchReport,
  fetchReportOptions,
  formFromSchedule,
  removeInline,
  removeRecipient,
  reportStateTone,
  scheduleFromForm,
  selectAllShared,
  selectionBody,
  selectionFromDetail,
  setInlineSave,
  toggleLibrary,
  togglePersonal,
  transferOwner,
  updateReport,
  type QuestionSelectionState,
  type ScheduleForm,
} from "./reports-client";
import { Button, Dropdown, INPUT, Segmented } from "@/components/ui";
import { TONE_INK, TONE_STYLE } from "./tone";

/** The kit's input, with the gap under its label. Buttons are the kit's `Button` (2026-11-10). */
const FIELD = `${INPUT} mt-1`;

const WEEKDAYS: Array<{ n: number; label: string }> = [
  { n: 1, label: "Mon" },
  { n: 2, label: "Tue" },
  { n: 3, label: "Wed" },
  { n: 4, label: "Thu" },
  { n: 5, label: "Fri" },
  { n: 6, label: "Sat" },
  { n: 7, label: "Sun" },
];

export interface EditorViewer {
  email: string;
  name: string;
}

interface DetailsForm {
  name: string;
  description: string;
  siteId: string;
  stationIds: string[];
  analysisWindow: AnalysisWindow;
  schedule: ScheduleForm;
  timeOfDay: string;
}

/**
 * The editor: one page with sections, saved as a draft until activated.
 *
 * Two modes, one component. With no `reportId` the page holds the details,
 * the questions, the window and the schedule, and the first save CREATES the
 * draft with its questions and moves to its page; recipients need a report
 * to belong to, so that section fills in once it exists. With a `reportId`
 * every section is live: details and questions save together with one
 * button, recipients save as they are changed, and the last section
 * activates, pauses, resumes or deletes.
 *
 * THE QUESTIONS ARE A CHECKLIST (2026-11-12). Every enabled shared question
 * is listed with a box, grouped by section, visible before any save; a
 * preset button ticks its set and unticks the other shared questions, and
 * the person ticks or unticks anything after. My questions have boxes too,
 * and a custom question is typed in here. Nothing is locked. The selection
 * lives in the form until Save writes it whole; the server stores it in
 * library order, then mine, then typed, and keeps the preset's name as a
 * label only while the shared part still matches.
 *
 * No Limits section: the module's safety ceiling, on the Usage page, applies
 * to every run (2026-11-12).
 *
 * The schedule is previewed with the SAME function the server stores it
 * with (`computeNextRun`), in the building's zone and in UTC, so what the
 * form promises and what the row holds cannot differ.
 */
export function ReportEditor({ reportId, viewer }: { reportId: string | null; viewer: EditorViewer }) {
  const router = useRouter();
  const [options, setOptions] = useState<ReportOptions | null>(null);
  const [library, setLibrary] = useState<LibraryQuestionView[] | null>(null);
  const [personal, setPersonal] = useState<PersonalQuestionView[] | null>(null);
  const [report, setReport] = useState<ReportDetail | null>(null);
  const [form, setForm] = useState<DetailsForm | null>(null);
  const [selection, setSelection] = useState<QuestionSelectionState>(emptySelection());
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadReport = useCallback(async (signal?: AbortSignal) => {
    if (reportId === null) return null;
    const detail = await fetchReport(reportId, signal);
    setReport(detail);
    setSelection(selectionFromDetail(detail));
    return detail;
  }, [reportId]);

  const reloadPersonal = useCallback(async () => {
    setPersonal(await fetchPersonal());
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const [opts, lib, mine, detail] = await Promise.all([
          fetchReportOptions(controller.signal),
          fetchLibrary(controller.signal),
          fetchPersonal(controller.signal),
          loadReport(controller.signal),
        ]);
        setOptions(opts);
        setLibrary(lib);
        setPersonal(mine);
        const firstSite = opts.sites[0];
        const timezone = detail?.site.timezone ?? firstSite?.timezone ?? "UTC";
        setForm(
          detail === null
            ? {
                name: "",
                description: "",
                siteId: firstSite?.siteId ?? "",
                stationIds: [],
                analysisWindow: "7d",
                schedule: formFromSchedule(null, todayIn(timezone)),
                timeOfDay: "06:00",
              }
            : {
                name: detail.name,
                description: detail.description ?? "",
                siteId: detail.site.siteId,
                stationIds: detail.stationIds,
                analysisWindow: detail.analysisWindow,
                schedule: formFromSchedule(detail.schedule, todayIn(timezone)),
                timeOfDay: detail.timeOfDay,
              },
        );
        setError(null);
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError(cause instanceof ApiError ? cause : new ApiError("unexpected", "Something went wrong."));
      }
    })();
    return () => controller.abort();
  }, [loadReport]);

  /** Run a write, then reload the report. Errors shown as the server wrote them. */
  const run = useCallback(
    async (action: () => Promise<unknown>, done?: string): Promise<boolean> => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        await action();
        await loadReport();
        if (done !== undefined) setNotice(done);
        return true;
      } catch (cause) {
        setError(cause instanceof ApiError ? cause : new ApiError("unexpected", "Something went wrong."));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [loadReport],
  );

  const site = useMemo(
    () => options?.sites.find((s) => s.siteId === form?.siteId) ?? null,
    [options, form?.siteId],
  );
  const timezone = site?.timezone ?? report?.site.timezone ?? "UTC";

  const spec = form === null ? null : scheduleFromForm(form.schedule);
  const scheduleIssue = spec === null ? "Complete the schedule." : scheduleProblem(spec);
  const preview = useMemo(() => {
    if (spec === null || scheduleIssue !== null || form === null) return null;
    try {
      return computeNextRun(spec, form.timeOfDay, timezone, new Date());
    } catch {
      return null;
    }
  }, [spec, scheduleIssue, form, timezone]);

  if (form === null || options === null || library === null) {
    return <p className="p-6 text-sm text-[var(--muted)]">{error?.message ?? "Loading…"}</p>;
  }

  const set = (patch: Partial<DetailsForm>) => setForm((f) => (f === null ? f : { ...f, ...patch }));

  const detailsBody = (): CreateReportInput | null => {
    if (spec === null) return null;
    return {
      name: form.name,
      description: form.description.length === 0 ? null : form.description,
      siteId: form.siteId,
      stationIds: form.stationIds,
      presetKey: selection.presetClicked,
      analysisWindow: form.analysisWindow,
      schedule: spec,
      timeOfDay: form.timeOfDay,
      questions: selectionBody(selection, library),
    };
  };

  const saveDetails = async () => {
    const body = detailsBody();
    if (body === null) {
      setError(new ApiError("validation_failed", scheduleIssue ?? "Complete the schedule."));
      return;
    }
    const savesForReuse = selection.inline.some((d) => d.save);
    if (reportId === null) {
      await run(async () => {
        const created = await createReport(body);
        router.push(`/bas/reports/${encodeURIComponent(created.reportId)}`);
      }, "Draft saved.");
    } else {
      const patch: UpdateReportInput = { ...body };
      const ok = await run(() => updateReport(reportId, patch), "Saved.");
      if (ok && savesForReuse) await reloadPersonal();
    }
  };

  const ownerEmail = report?.ownerEmail ?? viewer.email;
  const ownerName = report?.ownerName ?? viewer.name;
  // My questions go on my own reports: a new report is mine, an existing one
  // is the owner's. A module admin editing somebody else's report keeps the
  // owner's questions and types any of their own in.
  const canUsePersonal = report === null || report.isOwner;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <Link href="/bas/reports/scheduled" className="text-sm text-[var(--muted)] hover:underline">
          ← Scheduled reports
        </Link>
        {report !== null && <StateChip state={report.state} />}
      </div>

      {error !== null && (
        <p className="rounded-[var(--radius-row)] border p-4 text-sm" style={TONE_STYLE.bad} role="alert">
          {error.message}
        </p>
      )}
      {notice !== null && (
        <p className="rounded-[var(--radius-row)] border p-3 text-sm" style={TONE_STYLE.ok} role="status">
          {notice}
        </p>
      )}

      {/* 1. Details */}
      <Section title="Details" n={1}>
        <Field label="Name">
          <input className={FIELD} value={form.name} maxLength={120} onChange={(e) => set({ name: e.target.value })} required />
        </Field>
        <Field label="Description" hint="Optional.">
          <textarea className={FIELD + " h-auto py-2"} rows={2} maxLength={2000} value={form.description} onChange={(e) => set({ description: e.target.value })} />
        </Field>
        <Field label="Building">
          <Dropdown
            label="Building"
            value={form.siteId}
            onChange={(siteId) => set({ siteId, stationIds: [] })}
            placeholder="No buildings are registered"
            options={options.sites.map((s) => ({
              value: s.siteId,
              label: `${s.projectName} → ${s.name} (${s.timezone})`,
            }))}
            className="mt-1"
          />
        </Field>
        {site !== null && site.stations.length > 1 && (
          <Field label="Stations" hint="None ticked means every station on the building.">
            <ul className="mt-1 flex flex-wrap gap-3 text-sm">
              {site.stations.map((st) => {
                const checked = form.stationIds.includes(st.stationId);
                return (
                  <li key={st.stationId}>
                    <label className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) =>
                          set({
                            stationIds: e.target.checked
                              ? [...form.stationIds, st.stationId]
                              : form.stationIds.filter((id) => id !== st.stationId),
                          })
                        }
                      />
                      {st.name}
                    </label>
                  </li>
                );
              })}
            </ul>
          </Field>
        )}
      </Section>

      {/* 2. Questions */}
      <Section title="Questions" n={2}>
        <QuestionsChecklist
          library={library}
          personal={personal ?? []}
          selection={selection}
          onChange={setSelection}
          canUsePersonal={canUsePersonal}
          ownerQuestionsOnReport={report?.questions.filter((q) => q.kind === "personal") ?? []}
          disabled={busy}
        />
      </Section>

      {/* 3. Analysis window */}
      <Section title="Analysis window" n={3}>
        <Segmented
          tone="light"
          label="Analysis window"
          options={ANALYSIS_WINDOWS.map((w) => ({ value: w, label: WINDOW_LABELS[w] }))}
          value={form.analysisWindow}
          onChange={(analysisWindow) => set({ analysisWindow })}
        />
        <p className="mt-2 text-xs text-[var(--muted)]">
          How far back each run looks. Independent of how often it runs.
        </p>
      </Section>

      {/* 4. Schedule */}
      <Section title="Schedule" n={4}>
        <ScheduleFields
          form={form.schedule}
          timeOfDay={form.timeOfDay}
          onChange={(schedule) => set({ schedule })}
          onTime={(timeOfDay) => set({ timeOfDay })}
        />
        <p className="mt-3 text-sm">
          {scheduleIssue !== null ? (
            <span style={{ color: TONE_INK.warn }}>{scheduleIssue}</span>
          ) : spec !== null ? (
            <>
              {describeCadence(spec, form.timeOfDay)}, {timezone} time.
              {preview !== null && (
                <>
                  {" "}
                  Next run would be <span className="font-medium">{describeNextRun(preview.toISOString(), timezone)}</span>.
                </>
              )}
            </>
          ) : null}
        </p>
      </Section>

      {/* 5. Recipients */}
      <Section title="Recipients" n={5}>
        <OwnerRow name={ownerName} email={ownerEmail} />
        {report !== null && options.canAdminister && (
          <TransferOwner
            owners={options.owners.filter((o) => o.employeeId !== report.ownerEmployeeId)}
            busy={busy}
            onTransfer={(employeeId) => run(() => transferOwner(report.reportId, employeeId), "Owner transferred.")}
          />
        )}
        {report === null ? (
          <p className="mt-3 text-sm text-[var(--muted)]">Save the draft to add more recipients.</p>
        ) : (
          <RecipientsSection
            report={report}
            companyDomain={options.companyEmailDomain}
            busy={busy}
            onAdd={(email, confirmed) =>
              run(() => addRecipient(report.reportId, { email, confirmed }), `${email} added.`)
            }
            onRemove={(email) => run(() => removeRecipient(report.reportId, email))}
            lastError={error}
          />
        )}
      </Section>

      {/* 6. Review and activate */}
      <Section title="Review and activate" n={6}>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
          <dt className="text-[var(--muted)]">Report</dt>
          <dd>{form.name.length > 0 ? form.name : "(unnamed)"}</dd>
          <dt className="text-[var(--muted)]">Building</dt>
          <dd>{site?.name ?? "—"}{form.stationIds.length > 0 ? ` · ${form.stationIds.length} stations` : ""}</dd>
          <dt className="text-[var(--muted)]">Questions</dt>
          <dd>{describeSelection(selection, library)}</dd>
          <dt className="text-[var(--muted)]">Window</dt>
          <dd>{WINDOW_LABELS[form.analysisWindow]}</dd>
          <dt className="text-[var(--muted)]">Schedule</dt>
          <dd>{spec === null ? "—" : `${describeCadence(spec, form.timeOfDay)} (${timezone})`}</dd>
          <dt className="text-[var(--muted)]">Recipients</dt>
          <dd>{ownerEmail}{report !== null && report.recipients.length > 0 ? ` + ${report.recipients.length}` : ""}</dd>
          <dt className="text-[var(--muted)]">State</dt>
          <dd>{report === null ? "Not saved" : REPORT_STATE_LABELS[report.state]}</dd>
        </dl>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button className="font-medium" disabled={busy || options.sites.length === 0} onClick={() => void saveDetails()}>
            {reportId === null ? "Save as draft" : "Save changes"}
          </Button>
          {report !== null && (report.state === "draft" || report.state === "paused") && (
            <Button
              disabled={busy}
              onClick={() => run(() => changeReportState(report.reportId, report.state === "paused" ? "resume" : "activate"), "Activated.")}
            >
              {report.state === "paused" ? "Resume" : "Activate"}
            </Button>
          )}
          {report !== null && report.state === "active" && (
            <Button  disabled={busy} onClick={() => run(() => changeReportState(report.reportId, "pause"), "Paused.")}>
              Pause
            </Button>
          )}
          {report !== null && (
            <Button
              disabled={busy}
              onClick={() => {
                if (window.confirm(`Delete the report "${report.name}"?`)) {
                  void run(async () => {
                    await deleteReport(report.reportId);
                    router.push("/bas/reports/scheduled");
                  });
                }
              }}
            >
              Delete report
            </Button>
          )}
        </div>
        {report !== null && report.state === "active" && (
          <p className="mt-3 text-sm text-[var(--muted)]">
            Next run: {describeNextRun(report.nextRunAt, report.site.timezone)}.
          </p>
        )}
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function Section({ title, n, children }: { title: string; n: number; children: React.ReactNode }) {
  return (
    <section className="card p-5">
      <h2 className="eyebrow text-[var(--muted)]">
        {n}. {title}
      </h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="mb-3 block text-sm">
      <span className="text-[0.75rem] text-[var(--muted)]">{label}</span>
      {children}
      {hint !== undefined && <span className="mt-1 block text-xs text-[var(--muted)]">{hint}</span>}
    </label>
  );
}

export function StateChip({ state }: { state: ReportDetail["state"] }) {
  const tone = reportStateTone(state);
  return (
    <span className="inline-block rounded-full border px-2.5 py-0.5 text-[0.6875rem] font-medium" style={{ ...TONE_STYLE[tone], color: TONE_INK[tone] }}>
      {REPORT_STATE_LABELS[state]}
    </span>
  );
}

/**
 * A module admin hands the report to another owner (Phase 3). The one way a
 * report the scheduler paused for a disabled owner runs again, so the form
 * says so. The owner row above stays as it is: the transfer is a separate,
 * deliberate act, not an edit of a field.
 */
function TransferOwner({
  owners,
  busy,
  onTransfer,
}: {
  owners: OwnerOption[];
  busy: boolean;
  onTransfer: (employeeId: string) => Promise<boolean>;
}) {
  const [to, setTo] = useState("");
  return (
    <div className="mt-3 flex flex-wrap items-end gap-2">
      <Field label="Transfer to another owner" hint="Module admins only. A report paused because its owner's account was disabled is resumed by this.">
        <Dropdown
          label="New owner"
          value={to}
          onChange={setTo}
          placeholder="Choose an employee"
          options={owners.map((o) => ({ value: o.employeeId, label: `${o.name} (${o.email})` }))}
          className="mt-1 min-w-[18rem]"
        />
      </Field>
      <Button size="sm" disabled={busy || to.length === 0} onClick={() => void onTransfer(to).then((ok) => ok && setTo(""))}>
        Transfer owner
      </Button>
    </div>
  );
}

/** Owner first, locked, labelled required. Not a row anywhere - a fact rendered. */
export function OwnerRow({ name, email }: { name: string; email: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-[var(--radius-row)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm">
      <span>
        <span className="font-medium">{name}</span> <span className="text-[var(--muted)]">{email}</span>
      </span>
      <span className="text-xs text-[var(--muted)]">{OWNER_ROW_LABEL}</span>
    </div>
  );
}

/** The label beside a shared question: its section, how it is answered, and what it applies to. */
export function questionMeta(q: Pick<LibraryQuestionView, "sectionLabel" | "kind" | "appliesToLabel">): string {
  return `${q.sectionLabel} · ${q.kind} · ${q.appliesToLabel}`;
}

/**
 * The checklist (2026-11-12). Pure in its props, so a node test can render
 * it empty, after a preset, and with a custom question, and read the boxes.
 *
 * Every enabled shared question, grouped by section in library order, with
 * a box; a shared question since turned off is listed only while it is
 * ticked, and says so. Above the list the four buttons; below it My
 * questions with boxes, then the custom questions on this report and the
 * box to type one. The buttons act on the shared list only - mixing is the
 * point, and a preset click must not untick a question of mine.
 */
export function QuestionsChecklist({
  library,
  personal,
  selection,
  onChange,
  canUsePersonal,
  ownerQuestionsOnReport = [],
  disabled = false,
}: {
  library: LibraryQuestionView[];
  personal: PersonalQuestionView[];
  selection: QuestionSelectionState;
  onChange: (next: QuestionSelectionState) => void;
  /** Whether My questions and "save for reuse" are offered: the viewer owns (or is creating) the report. */
  canUsePersonal: boolean;
  /** For a module admin on somebody else's report: the owner's own questions, kept and shown read-only. */
  ownerQuestionsOnReport?: ReportQuestionView[];
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const ticked = new Set(selection.library);
  const tickedPersonal = new Set(selection.personal);
  const offered = [...library]
    .filter((q) => q.enabled || ticked.has(q.libraryQuestionId))
    .sort((a, b) => a.position - b.position || a.libraryQuestionId.localeCompare(b.libraryQuestionId));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Shared question presets">
          <Button size="sm" disabled={disabled} onClick={() => onChange(selectAllShared(selection, library))}>
            Select all
          </Button>
          {PRESET_KEYS.map((key) => (
            <Button key={key} size="sm" disabled={disabled} title={REPORT_PRESETS[key].description} onClick={() => onChange(applyPreset(selection, key, library))}>
              {REPORT_PRESETS[key].label === "Standard weekly health report" ? "Standard weekly" : "Daily critical-site"}
            </Button>
          ))}
          <Button size="sm" disabled={disabled} onClick={() => onChange(clearShared(selection))}>
            Clear
          </Button>
        </div>
        <span className="text-sm text-[var(--muted)]" data-testid="questions-summary">{describeSelection(selection, library)}</span>
      </div>

      <div className="max-h-[30rem] overflow-auto rounded-[var(--radius-row)] border border-[var(--border)]" role="group" aria-label="Shared questions">
        {LIBRARY_SECTIONS.map((section) => {
          const rows = offered.filter((q) => q.section === section.key);
          if (rows.length === 0) return null;
          return (
            <div key={section.key}>
              <div className="sticky top-0 z-10 bg-[var(--surface)] px-3 py-1 text-xs font-medium text-[var(--muted)]">{section.label}</div>
              {rows.map((q) => (
                <label key={q.libraryQuestionId} className="flex items-start gap-3 border-t border-[var(--divider-soft)] px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={ticked.has(q.libraryQuestionId)}
                    disabled={disabled}
                    onChange={(e) => onChange(toggleLibrary(selection, q.libraryQuestionId, e.target.checked))}
                    aria-label={`Q${q.position}: ${q.text}`}
                  />
                  <span className="w-7 shrink-0 tabular-nums text-[var(--muted)]">{q.position}.</span>
                  <span className="min-w-0 flex-1">
                    {q.text}
                    <span className="ml-2 text-xs text-[var(--muted)]">{questionMeta(q)}</span>
                    {!q.enabled && (
                      <span className="ml-2 inline-block rounded-full border px-2 py-0.5 text-[0.6875rem] font-medium" style={{ ...TONE_STYLE.warn, color: TONE_INK.warn }}>
                        turned off
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </div>
          );
        })}
        {offered.length === 0 && <p className="px-3 py-3 text-sm text-[var(--muted)]">The shared library is empty. Run the seed.</p>}
      </div>

      {canUsePersonal ? (
        <div>
          <h3 className="text-sm font-medium">My questions</h3>
          <ul className="mt-2 divide-y divide-[var(--divider-soft)] rounded-[var(--radius-row)] border border-[var(--border)]" aria-label="My questions">
            {personal.length === 0 && (
              <li className="px-3 py-2 text-sm text-[var(--muted)]">Nothing saved yet. Tick &ldquo;save for reuse&rdquo; on a custom question below to keep it here.</li>
            )}
            {personal.map((p) => (
              <li key={p.personalQuestionId}>
                <label className="flex items-start gap-3 px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={tickedPersonal.has(p.personalQuestionId)}
                    disabled={disabled}
                    onChange={(e) => onChange(togglePersonal(selection, p.personalQuestionId, e.target.checked))}
                    aria-label={p.text}
                  />
                  <span className="min-w-0 flex-1">
                    {p.text}
                    <span className="ml-2 text-xs text-[var(--muted)]">my question · planner</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      ) : ownerQuestionsOnReport.length > 0 ? (
        <div>
          <h3 className="text-sm font-medium">The owner&apos;s questions on this report</h3>
          <ul className="mt-2 divide-y divide-[var(--divider-soft)] rounded-[var(--radius-row)] border border-[var(--border)]" aria-label="The owner's questions">
            {ownerQuestionsOnReport.map((q) => (
              <li key={q.questionId} className="px-3 py-2 text-sm">
                {q.text}
                <span className="ml-2 text-xs text-[var(--muted)]">the owner&apos;s · kept when you save</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div>
        <h3 className="text-sm font-medium">Custom questions on this report</h3>
        <ul className="mt-2 divide-y divide-[var(--divider-soft)] rounded-[var(--radius-row)] border border-[var(--border)]" aria-label="Custom questions">
          {selection.inline.length === 0 && <li className="px-3 py-2 text-sm text-[var(--muted)]">None yet.</li>}
          {selection.inline.map((d) => (
            <li key={d.key} className="flex items-start gap-3 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1">
                {d.text}
                <span className="ml-2 text-xs text-[var(--muted)]">this report only · planner</span>
              </span>
              {canUsePersonal && (
                <label className="flex shrink-0 items-center gap-1.5 text-xs">
                  <input type="checkbox" checked={d.save} disabled={disabled} onChange={(e) => onChange(setInlineSave(selection, d.key, e.target.checked))} />
                  save for reuse
                </label>
              )}
              <Button size="sm" disabled={disabled} onClick={() => onChange(removeInline(selection, d.key))}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
        <label className="mt-3 block text-sm">
          <span className="text-[0.75rem] text-[var(--muted)]">Add a custom question to this report</span>
          <textarea
            className={FIELD + " h-auto py-2"}
            rows={2}
            maxLength={1000}
            value={draft}
            placeholder="e.g. Which VAVs were above setpoint for more than two hours while occupied?"
            onChange={(e) => setDraft(e.target.value)}
          />
        </label>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
          <Button
            size="sm"
            disabled={disabled || draft.trim().length === 0}
            onClick={() => {
              onChange(addInline(selection, draft));
              setDraft("");
            }}
          >
            Add
          </Button>
          <span className="text-xs text-[var(--muted)]">
            Saved with the report. Custom questions are answered by the Analyze planner when that phase runs.
          </span>
        </div>
      </div>
    </div>
  );
}

function ScheduleFields({
  form,
  timeOfDay,
  onChange,
  onTime,
}: {
  form: ScheduleForm;
  timeOfDay: string;
  onChange: (form: ScheduleForm) => void;
  onTime: (timeOfDay: string) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Frequency">
        <Dropdown
          label="Frequency"
          value={form.kind}
          onChange={(kind) => onChange({ ...form, kind: kind as ScheduleForm["kind"] })}
          options={[
            { value: "daily", label: "Daily" },
            { value: "every_n_days", label: "Every N days" },
            { value: "weekly", label: "Weekly, on chosen weekdays" },
            { value: "monthly", label: "Monthly, on a day" },
          ]}
          className="mt-1"
        />
      </Field>
      <Field label="Time of day" hint="24-hour, in the building's zone.">
        <input className={FIELD} type="time" value={timeOfDay} onChange={(e) => onTime(e.target.value)} required />
      </Field>
      {form.kind === "every_n_days" && (
        <>
          <Field label="Every N days">
            <input className={FIELD} inputMode="numeric" value={form.intervalDays} onChange={(e) => onChange({ ...form, intervalDays: e.target.value })} />
          </Field>
          <Field label="Counting from" hint="A calendar date in the building's zone.">
            <input className={FIELD} type="date" value={form.anchorDate} onChange={(e) => onChange({ ...form, anchorDate: e.target.value })} />
          </Field>
        </>
      )}
      {form.kind === "weekly" && (
        <div className="sm:col-span-2">
          <span className="text-sm font-medium">Weekdays</span>
          <div className="mt-1 flex flex-wrap gap-2">
            {WEEKDAYS.map((d) => {
              const on = form.weekdays.includes(d.n);
              return (
                <button
                  key={d.n}
                  type="button"
                  className={"rounded-full border border-[var(--border)] px-3 py-1 text-xs transition-colors" + (on ? " bg-[var(--surface)] font-medium" : "")}
                  aria-pressed={on}
                  onClick={() => onChange({ ...form, weekdays: on ? form.weekdays.filter((n) => n !== d.n) : [...form.weekdays, d.n] })}
                >
                  {d.label}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {form.kind === "monthly" && (
        <Field label="Day of the month" hint="1 to 31. A day the month lacks runs on its last day.">
          <input className={FIELD} inputMode="numeric" value={form.dayOfMonth} onChange={(e) => onChange({ ...form, dayOfMonth: e.target.value })} />
        </Field>
      )}
    </div>
  );
}

function RecipientsSection({
  report,
  companyDomain,
  busy,
  onAdd,
  onRemove,
  lastError,
}: {
  report: ReportDetail;
  companyDomain: string;
  busy: boolean;
  onAdd: (email: string, confirmed: boolean) => Promise<boolean>;
  onRemove: (email: string) => Promise<boolean>;
  lastError: ApiError | null;
}) {
  const [email, setEmail] = useState("");
  const [pendingExternal, setPendingExternal] = useState<string | null>(null);

  // The server said "external, not confirmed": show the warning for THAT address.
  useEffect(() => {
    if (lastError?.code === "external_unconfirmed") setPendingExternal(email.trim().toLowerCase());
  }, [lastError, email]);

  const submit = async (confirmed: boolean) => {
    const address = email.trim().toLowerCase();
    if (address.length === 0) return;
    const ok = await onAdd(address, confirmed);
    if (ok) {
      setEmail("");
      setPendingExternal(null);
    }
  };

  return (
    <div className="mt-3 space-y-3">
      <ul className="divide-y divide-[var(--divider-soft)] rounded-[var(--radius-row)] border border-[var(--border)]" aria-label="Additional recipients">
        {report.recipients.length === 0 && <li className="px-3 py-2 text-sm text-[var(--muted)]">No additional recipients.</li>}
        {report.recipients.map((r) => (
          <li key={r.email} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
            <span>
              {r.email}
              {r.isExternal && (
                <span className="ml-2 inline-block rounded-full border px-2 py-0.5 text-[0.6875rem] font-medium" style={{ ...TONE_STYLE.warn, color: TONE_INK.warn }}>
                  {EXTERNAL_CHIP}
                </span>
              )}
            </span>
            <Button size="sm"  disabled={busy} onClick={() => void onRemove(r.email)}>Remove</Button>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-end gap-2">
        <label className="text-sm">
          <span className="font-medium">Add an address</span>
          <input className={FIELD + " min-w-[18rem]"} type="email" value={email} onChange={(e) => { setEmail(e.target.value); setPendingExternal(null); }} />
        </label>
        <Button  disabled={busy || email.trim().length === 0} onClick={() => void submit(false)}>
          Add
        </Button>
      </div>

      {pendingExternal !== null && (
        <div className="rounded-[var(--radius-row)] border p-4 text-sm" style={TONE_STYLE.warn} role="alertdialog" aria-label="Confirm an external recipient">
          <p className="font-medium">{pendingExternal} is outside {companyDomain}.</p>
          <p className="mt-1">
            This building&apos;s health report, with its equipment names and readings, will be emailed there on every run. The addition is recorded in the audit log as an external recipient.
          </p>
          <div className="mt-3 flex gap-2">
            <Button  disabled={busy} onClick={() => void submit(true)}>
              Add external recipient
            </Button>
            <Button  disabled={busy} onClick={() => setPendingExternal(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
