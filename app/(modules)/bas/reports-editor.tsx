"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { LIBRARY_SECTIONS } from "@/lib/modules/bas/reports/library";
import { PRESET_KEYS, REPORT_PRESETS, type PresetKey } from "@/lib/modules/bas/reports/presets";
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
} from "@/lib/modules/bas/reports/types";
import type { CreateReportInput, UpdateReportInput } from "@/lib/validation/bas-reports";
import { ApiError } from "./health-client";
import {
  EXTERNAL_CHIP,
  OWNER_ROW_LABEL,
  addQuestion,
  addRecipient,
  changeReportState,
  createReport,
  deleteReport,
  describeNextRun,
  fetchLibrary,
  fetchPersonal,
  fetchReport,
  fetchReportOptions,
  formFromSchedule,
  removeQuestion,
  removeRecipient,
  reorderQuestions,
  reportStateTone,
  scheduleFromForm,
  transferOwner,
  updateReport,
  type ScheduleForm,
} from "./reports-client";
import { Button, Dropdown, INPUT, SearchBar, Segmented } from "@/components/ui";
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
  presetKey: PresetKey | null;
  analysisWindow: AnalysisWindow;
  schedule: ScheduleForm;
  timeOfDay: string;
  budgetUsd: string;
  maxMinutes: string;
}

/**
 * The editor: one page with sections, saved as a draft until activated.
 *
 * Two modes, one component. With no `reportId` the page holds the details,
 * window, schedule and budget and the first save CREATES the draft and moves
 * to its page; questions and recipients need a report to belong to, so those
 * sections appear once it exists. With a `reportId` every section is live:
 * details save together with one button, questions and recipients save as
 * they are changed, and the last section activates, pauses, resumes or
 * deletes.
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
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadReport = useCallback(async (signal?: AbortSignal) => {
    if (reportId === null) return null;
    const detail = await fetchReport(reportId, signal);
    setReport(detail);
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
                presetKey: "health_weekly",
                analysisWindow: "7d",
                schedule: formFromSchedule(null, todayIn(timezone)),
                timeOfDay: "06:00",
                budgetUsd: opts.defaultBudgetUsd.toFixed(2),
                maxMinutes: String(opts.defaultMaxMinutes),
              }
            : {
                name: detail.name,
                description: detail.description ?? "",
                siteId: detail.site.siteId,
                stationIds: detail.stationIds,
                presetKey: detail.presetKey,
                analysisWindow: detail.analysisWindow,
                schedule: formFromSchedule(detail.schedule, todayIn(timezone)),
                timeOfDay: detail.timeOfDay,
                budgetUsd: detail.budgetUsd.toFixed(2),
                maxMinutes: String(detail.maxMinutes),
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

  if (form === null || options === null) {
    return <p className="p-6 text-sm text-[var(--muted)]">{error?.message ?? "Loading…"}</p>;
  }

  const set = (patch: Partial<DetailsForm>) => setForm((f) => (f === null ? f : { ...f, ...patch }));

  const detailsBody = (): CreateReportInput | null => {
    if (spec === null) return null;
    const budget = Number(form.budgetUsd);
    const minutes = Number(form.maxMinutes);
    return {
      name: form.name,
      description: form.description.length === 0 ? null : form.description,
      siteId: form.siteId,
      stationIds: form.stationIds,
      presetKey: form.presetKey,
      analysisWindow: form.analysisWindow,
      schedule: spec,
      timeOfDay: form.timeOfDay,
      budgetUsd: Number.isFinite(budget) && budget > 0 ? Math.round(budget * 100) / 100 : undefined,
      maxMinutes: Number.isInteger(minutes) && minutes > 0 ? minutes : undefined,
    };
  };

  const saveDetails = async () => {
    const body = detailsBody();
    if (body === null) {
      setError(new ApiError("validation_failed", scheduleIssue ?? "Complete the schedule."));
      return;
    }
    if (reportId === null) {
      await run(async () => {
        const created = await createReport(body);
        router.push(`/bas/reports/${encodeURIComponent(created.reportId)}`);
      }, "Draft saved.");
    } else {
      const patch: UpdateReportInput = { ...body };
      await run(() => updateReport(reportId, patch), "Saved.");
    }
  };

  const ownerEmail = report?.ownerEmail ?? viewer.email;
  const ownerName = report?.ownerName ?? viewer.name;

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
        <PresetButtons value={form.presetKey} onChange={(presetKey) => set({ presetKey })} />
        {report === null ? (
          <p className="mt-3 text-sm text-[var(--muted)]">
            Save the draft to add questions. A preset chosen above is added when the draft is saved.
          </p>
        ) : (
          <QuestionsSection
            report={report}
            presetPending={form.presetKey !== report.presetKey}
            library={library ?? []}
            personal={personal ?? []}
            busy={busy}
            canUsePersonal={report.isOwner}
            onAdd={async (body) => {
              const ok = await run(() => addQuestion(report.reportId, body));
              if (ok && body.kind === "inline" && body.saveToLibrary === true) await reloadPersonal();
            }}
            onRemove={(questionId) => run(() => removeQuestion(report.reportId, questionId))}
            onReorder={(ids) => run(() => reorderQuestions(report.reportId, ids))}
          />
        )}
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

      {/* 6. Limits */}
      <Section title="Limits" n={6}>
        <Field label="Cost budget per run (USD)" hint="The model stops being asked for narrative when a run's spend would pass it. The run finishes with what it has and says so.">
          <input className={FIELD + " max-w-[10rem]"} inputMode="decimal" value={form.budgetUsd} onChange={(e) => set({ budgetUsd: e.target.value })} />
        </Field>
        <Field label="Time cap per run (minutes)" hint={`Questions and narrative still waiting when a run has taken this long are skipped and named; the run finishes partial. 1 to ${options.maxMinutesLimit}.`}>
          <input className={FIELD + " max-w-[10rem]"} inputMode="numeric" value={form.maxMinutes} onChange={(e) => set({ maxMinutes: e.target.value })} />
        </Field>
      </Section>

      {/* 7. Review and activate */}
      <Section title="Review and activate" n={7}>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
          <dt className="text-[var(--muted)]">Report</dt>
          <dd>{form.name.length > 0 ? form.name : "(unnamed)"}</dd>
          <dt className="text-[var(--muted)]">Building</dt>
          <dd>{site?.name ?? "—"}{form.stationIds.length > 0 ? ` · ${form.stationIds.length} stations` : ""}</dd>
          <dt className="text-[var(--muted)]">Questions</dt>
          <dd>
            {form.presetKey !== null
              ? `${REPORT_PRESETS[form.presetKey].label} (${REPORT_PRESETS[form.presetKey].questionKeys.length}, locked)`
              : `${report?.questions.length ?? 0} custom`}
          </dd>
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
              onClick={() => run(() => changeReportState(report.reportId, report.state === "paused" ? "resume" : "activate"), "Activated. Runs begin when the next phase switches them on.")}
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
            Next run: {describeNextRun(report.nextRunAt, report.site.timezone)}. Nothing fires until the phase that runs reports is switched on.
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

function PresetButtons({ value, onChange }: { value: PresetKey | null; onChange: (key: PresetKey | null) => void }) {
  return (
    <Segmented
      tone="light"
      label="Questions"
      options={[
        ...PRESET_KEYS.map((key) => ({
          value: key as string,
          label: <span title={REPORT_PRESETS[key].description}>{REPORT_PRESETS[key].label} (locked)</span>,
        })),
        {
          value: "custom",
          label: <span title="Pick from the shared questions, your own, or type them.">Custom</span>,
        },
      ]}
      value={value ?? "custom"}
      onChange={(next) => onChange(next === "custom" ? null : (next as PresetKey))}
    />
  );
}

function QuestionsSection({
  report,
  presetPending,
  library,
  personal,
  busy,
  canUsePersonal,
  onAdd,
  onRemove,
  onReorder,
}: {
  report: ReportDetail;
  presetPending: boolean;
  library: LibraryQuestionView[];
  personal: PersonalQuestionView[];
  busy: boolean;
  canUsePersonal: boolean;
  onAdd: (body: Parameters<typeof addQuestion>[1]) => Promise<void>;
  onRemove: (questionId: string) => Promise<boolean>;
  onReorder: (questionIds: string[]) => Promise<boolean>;
}) {
  const [search, setSearch] = useState("");
  const [inline, setInline] = useState("");
  const [save, setSave] = useState(false);
  const locked = report.presetKey !== null;

  const move = (index: number, delta: number) => {
    const ids = report.questions.map((q) => q.questionId);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    const [moved] = ids.splice(index, 1);
    if (moved === undefined) return;
    ids.splice(target, 0, moved);
    void onReorder(ids);
  };

  const onReport = new Set(report.questions.map((q) => q.libraryQuestionId ?? `p:${q.personalQuestionId ?? ""}`));
  const term = search.trim().toLowerCase();
  const offered = library.filter(
    (q) => q.enabled && (term.length === 0 || q.text.toLowerCase().includes(term) || q.sectionLabel.toLowerCase().includes(term)),
  );

  return (
    <div className="mt-4 space-y-4">
      {presetPending && (
        <p className="rounded-[var(--radius-row)] border p-3 text-sm" style={TONE_STYLE.warn}>
          The preset choice above is applied when you save changes.
        </p>
      )}
      {locked && (
        <p className="text-sm text-[var(--muted)]">
          {report.presetLabel}: {report.questions.length} questions in a fixed order. Choose Custom to vary them.
        </p>
      )}

      <ol className="divide-y divide-[var(--divider-soft)] rounded-[var(--radius-row)] border border-[var(--border)]" aria-label="Questions on this report">
        {report.questions.length === 0 && (
          <li className="px-3 py-3 text-sm text-[var(--muted)]">No questions yet. Add some below.</li>
        )}
        {report.questions.map((q, i) => (
          <li key={q.questionId} className="flex items-start gap-3 px-3 py-2 text-sm">
            <span className="w-6 shrink-0 tabular-nums text-[var(--muted)]">{i + 1}.</span>
            <span className="min-w-0 flex-1">
              {q.text}
              <span className="ml-2 text-xs text-[var(--muted)]">
                {q.kind === "library" ? `${q.sectionLabel} · ${q.libraryKind} · ${q.appliesToLabel}` : q.kind === "personal" ? "my question" : "typed"}
              </span>
            </span>
            {!locked && (
              <span className="flex shrink-0 gap-1">
                <Button size="sm"  disabled={busy || i === 0} ariaLabel="Move up" onClick={() => move(i, -1)}>↑</Button>
                <Button size="sm"  disabled={busy || i === report.questions.length - 1} ariaLabel="Move down" onClick={() => move(i, 1)}>↓</Button>
                <Button size="sm"  disabled={busy} onClick={() => void onRemove(q.questionId)}>Remove</Button>
              </span>
            )}
          </li>
        ))}
      </ol>

      {!locked && (
        <>
          <div>
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-medium">Shared questions</h3>
              <SearchBar label="Search the shared questions" placeholder="Search" value={search} onChange={setSearch} hotkey={false} className="w-56" />
            </div>
            <div className="mt-2 max-h-72 overflow-auto rounded-[var(--radius-row)] border border-[var(--border)]">
              {LIBRARY_SECTIONS.map((section) => {
                const rows = offered.filter((q) => q.section === section.key);
                if (rows.length === 0) return null;
                return (
                  <div key={section.key}>
                    <div className="sticky top-0 bg-[var(--surface)] px-3 py-1 text-xs font-medium text-[var(--muted)]">{section.label}</div>
                    {rows.map((q) => (
                      <div key={q.libraryQuestionId} className="flex items-start gap-3 border-t border-[var(--divider-soft)] px-3 py-2 text-sm">
                        <span className="min-w-0 flex-1">
                          {q.text}
                          <span className="ml-2 inline-block rounded-full border border-[var(--border)] px-2 py-0.5 text-[0.6875rem] text-[var(--muted)]">{q.kind}</span>
                          <span className="ml-2 text-xs text-[var(--muted)]">applies to: {q.appliesToLabel}</span>
                        </span>
                        <Button size="sm"
                          disabled={busy || onReport.has(q.libraryQuestionId)}
                          onClick={() => void onAdd({ kind: "library", libraryQuestionId: q.libraryQuestionId })}
                        >
                          {onReport.has(q.libraryQuestionId) ? "Added" : "Add"}
                        </Button>
                      </div>
                    ))}
                  </div>
                );
              })}
              {offered.length === 0 && <p className="px-3 py-3 text-sm text-[var(--muted)]">Nothing matches.</p>}
            </div>
          </div>

          {canUsePersonal && personal.length > 0 && (
            <div>
              <h3 className="text-sm font-medium">My questions</h3>
              <ul className="mt-2 divide-y divide-[var(--divider-soft)] rounded-[var(--radius-row)] border border-[var(--border)]">
                {personal.map((p) => (
                  <li key={p.personalQuestionId} className="flex items-start gap-3 px-3 py-2 text-sm">
                    <span className="min-w-0 flex-1">{p.text}</span>
                    <Button size="sm"
                      disabled={busy || onReport.has(`p:${p.personalQuestionId}`)}
                      onClick={() => void onAdd({ kind: "personal", personalQuestionId: p.personalQuestionId })}
                    >
                      {onReport.has(`p:${p.personalQuestionId}`) ? "Added" : "Add"}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <h3 className="text-sm font-medium">Write a question</h3>
            <textarea className={FIELD + " h-auto py-2"} rows={2} maxLength={1000} value={inline} placeholder="e.g. Which VAVs were above setpoint for more than two hours while occupied?" onChange={(e) => setInline(e.target.value)} />
            <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
              <Button size="sm"
                disabled={busy || inline.trim().length === 0}
                onClick={() => {
                  void onAdd({ kind: "inline", text: inline.trim(), saveToLibrary: save && canUsePersonal }).then(() => setInline(""));
                }}
              >
                Add question
              </Button>
              {canUsePersonal && (
                <label className="flex items-center gap-1.5 text-xs">
                  <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />
                  Save to my questions
                </label>
              )}
              <span className="text-xs text-[var(--muted)]">Answered by the Analyze planner when runs begin.</span>
            </div>
          </div>
        </>
      )}
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
