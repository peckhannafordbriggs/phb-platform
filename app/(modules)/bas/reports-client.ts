import type {
  LastRunView,
  LibraryQuestionView,
  OwnerTransfer,
  PersonalQuestionView,
  RecipientView,
  ReportDetail,
  ReportOptions,
  ReportState,
  ReportStateChange,
  ReportsList,
} from "@/lib/modules/bas/reports/types";
import type { SafetyCeilingView } from "@/lib/modules/bas/reports/ceiling";
import { REPORT_PRESETS, presetMatching, type PresetKey } from "@/lib/modules/bas/reports/presets";
import type { ScheduleSpec } from "@/lib/modules/bas/reports/schedule";
import type { RunsList } from "@/lib/modules/bas/reports/runs-service";
import { formatInZone } from "@/lib/modules/bas/reports/schedule";
import type {
  AddRecipientInput,
  CreateReportInput,
  QuestionSelection,
  ReportStateAction,
  SafetyCeilingInput,
  UpdateReportInput,
} from "@/lib/validation/bas-reports";
import { ApiError, type Tone } from "./health-client";

/**
 * The browser's view of the Reports API (Phase 1), plus the pure functions
 * that decide how a state is coloured and how a next run reads. Separate from
 * the components so the rules can be imported by a node-environment test.
 */

const BASE = "/api/modules/bas/reports";

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      cache: "no-store",
      headers: init.body === undefined ? init.headers : { "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError("network", "Could not reach the server.");
  }

  const payload = (await response.json().catch(() => null)) as
    | { data?: T; error?: { code?: string; message?: string } }
    | null;

  if (!response.ok || payload?.error !== undefined) {
    // A 404 is either the grant gone or a report that is not the viewer's;
    // the body's code says which, and the screens show its message.
    throw new ApiError(
      payload?.error?.code ?? (response.status === 404 ? "not_found" : "unexpected"),
      payload?.error?.message ?? (response.status === 404 ? "Not found." : "Something went wrong."),
    );
  }

  return payload?.data as T;
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const fetchReports = (signal?: AbortSignal) => call<ReportsList>("", { signal });
export const fetchReport = (reportId: string, signal?: AbortSignal) =>
  call<ReportDetail>(`/${encodeURIComponent(reportId)}`, { signal });
export const fetchReportOptions = (signal?: AbortSignal) => call<ReportOptions>("/options", { signal });
export const fetchLibrary = (signal?: AbortSignal) => call<LibraryQuestionView[]>("/library", { signal });
export const fetchPersonal = (signal?: AbortSignal) => call<PersonalQuestionView[]>("/personal", { signal });
export const fetchRuns = (reportId: string | null, signal?: AbortSignal) =>
  call<RunsList>(reportId === null ? "/runs" : `/runs?report=${encodeURIComponent(reportId)}`, { signal });

export const createReport = (body: CreateReportInput) => call<{ reportId: string }>("", json("POST", body));
export const updateReport = (reportId: string, body: UpdateReportInput) =>
  call<{ changed: boolean; nextRunAt: string | null }>(`/${encodeURIComponent(reportId)}`, json("PATCH", body));
export const deleteReport = (reportId: string) =>
  call<{ deleted: boolean }>(`/${encodeURIComponent(reportId)}`, { method: "DELETE" });
/** Run now (Phase 3): queue a run; 202 with the run id, or 409 run_in_flight. */
export const requestRun = (reportId: string) =>
  call<{ runId: string }>(`/${encodeURIComponent(reportId)}/runs`, { method: "POST" });
/** Transfer the report to another owner (Phase 3, module admin). */
export const transferOwner = (reportId: string, ownerEmployeeId: string) =>
  call<OwnerTransfer>(`/${encodeURIComponent(reportId)}/owner`, json("PATCH", { ownerEmployeeId }));
export const changeReportState = (reportId: string, action: ReportStateAction) =>
  call<ReportStateChange>(`/${encodeURIComponent(reportId)}/state`, json("POST", { action }));

/** The module's safety ceiling (2026-11-12): read by anyone, set by a module admin (403 otherwise). */
export const fetchSafetyCeiling = (signal?: AbortSignal) => call<SafetyCeilingView>("/ceiling", { signal });
export const setSafetyCeiling = (body: SafetyCeilingInput) =>
  call<{ changed: boolean; ceiling: SafetyCeilingView }>("/ceiling", json("PATCH", body));

export const createPersonal = (text: string) =>
  call<{ personalQuestionId: string }>("/personal", json("POST", { text }));
export const updatePersonal = (personalQuestionId: string, text: string) =>
  call<{ changed: boolean }>(`/personal/${encodeURIComponent(personalQuestionId)}`, json("PATCH", { text }));
export const deletePersonal = (personalQuestionId: string) =>
  call<{ deleted: boolean }>(`/personal/${encodeURIComponent(personalQuestionId)}`, { method: "DELETE" });

export const addRecipient = (reportId: string, body: AddRecipientInput) =>
  call<RecipientView>(`/${encodeURIComponent(reportId)}/recipients`, json("POST", body));
export const removeRecipient = (reportId: string, email: string) =>
  call<{ removed: boolean }>(
    `/${encodeURIComponent(reportId)}/recipients/${encodeURIComponent(email)}`,
    { method: "DELETE" },
  );

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

/**
 * Quiet when fine, loud when broken: an active report is calm teal, a draft
 * has no opinion, a paused one is amber because a report somebody expects
 * is not arriving, and one paused by a disabled owner is maroon because
 * nobody chose it.
 */
export function reportStateTone(state: ReportState): Tone {
  switch (state) {
    case "active":
      return "ok";
    case "paused":
      return "warn";
    case "paused_owner_disabled":
      return "bad";
    case "draft":
      return "neutral";
  }
}

const UTC_FORMAT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  hourCycle: "h23",
  hour: "2-digit",
  minute: "2-digit",
});

/**
 * "Mon, 16 Nov 2026, 06:00 America/New_York (11:00 UTC)". Both clocks, because
 * the schedule is stored in the building's zone and a person checking a job
 * log reads UTC.
 */
export function describeNextRun(nextRunAt: string | null, timezone: string): string {
  if (nextRunAt === null) return "—";
  const instant = new Date(nextRunAt);
  if (Number.isNaN(instant.getTime())) return "—";
  return `${formatInZone(instant, timezone)} ${timezone} (${UTC_FORMAT.format(instant)} UTC)`;
}

/** The editor's schedule form, as the spec the API takes - or null while it is incomplete. */
export interface ScheduleForm {
  kind: ScheduleSpec["kind"];
  intervalDays: string;
  anchorDate: string;
  weekdays: number[];
  dayOfMonth: string;
}

export function scheduleFromForm(form: ScheduleForm): ScheduleSpec | null {
  switch (form.kind) {
    case "daily":
      return { kind: "daily" };
    case "every_n_days": {
      const n = Number(form.intervalDays);
      if (!Number.isInteger(n) || form.anchorDate.length === 0) return null;
      return { kind: "every_n_days", intervalDays: n, anchorDate: form.anchorDate };
    }
    case "weekly":
      return form.weekdays.length === 0 ? null : { kind: "weekly", weekdays: [...form.weekdays].sort((a, b) => a - b) };
    case "monthly": {
      const d = Number(form.dayOfMonth);
      return Number.isInteger(d) ? { kind: "monthly", dayOfMonth: d } : null;
    }
  }
}

export function formFromSchedule(spec: ScheduleSpec | null, anchorDefault: string): ScheduleForm {
  const base: ScheduleForm = { kind: "weekly", intervalDays: "3", anchorDate: anchorDefault, weekdays: [1], dayOfMonth: "1" };
  if (spec === null) return base;
  switch (spec.kind) {
    case "daily":
      return { ...base, kind: "daily" };
    case "every_n_days":
      return { ...base, kind: "every_n_days", intervalDays: String(spec.intervalDays), anchorDate: spec.anchorDate };
    case "weekly":
      return { ...base, kind: "weekly", weekdays: spec.weekdays };
    case "monthly":
      return { ...base, kind: "monthly", dayOfMonth: String(spec.dayOfMonth) };
  }
}

/** "3 of 4 stations", or "All stations" - the list's building column. */
export function describeStations(selected: number, onSite: number): string {
  if (selected === 0) return onSite === 1 ? "its 1 station" : `all ${onSite} stations`;
  return `${selected} of ${onSite} station${onSite === 1 ? "" : "s"}`;
}

/** "2 + owner" - the recipient column never forgets the one recipient who is not a row. */
export function describeRecipients(additional: number): string {
  return additional === 0 ? "owner only" : `${additional} + owner`;
}

/**
 * The newest run in the Scheduled list's words (Phase 3): the state, and
 * when - queued and running say when they were queued or started, the rest
 * when they finished - as the viewer's clock reads it. Null is the honest
 * "No runs yet".
 */
export function describeLastRun(run: LastRunView | null, now: Date = new Date()): string {
  if (run === null) return "No runs yet";
  const at = run.status === "queued" ? run.createdAt : run.status === "running" ? (run.startedAt ?? run.createdAt) : (run.finishedAt ?? run.createdAt);
  const label = run.status === "queued" ? "Queued" : run.status === "running" ? "Running" : run.status === "succeeded" ? "Succeeded" : run.status === "partial" ? "Partial" : "Failed";
  return `${label} ${describeAgo(new Date(at), now)}`;
}

function describeAgo(at: Date, now: Date): string {
  const s = Math.max(0, Math.round((now.getTime() - at.getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}

export const OWNER_ROW_LABEL = "Report owner · required";
export const EXTERNAL_CHIP = "external";

// ---------------------------------------------------------------------------
// The questions checklist (2026-11-12): the editor's selection, as pure
// functions, so the three tabs, their Select all and Clear, and the body
// they produce can be tested in node without rendering.
// ---------------------------------------------------------------------------

/** A question typed into this report and not yet saved as a row. */
export interface InlineDraft {
  /** A client-side key for React and for removal; never sent. */
  key: string;
  text: string;
  /** "Save for reuse": on save, also stored in My questions and put on the report as a personal one. */
  save: boolean;
}

export interface QuestionSelectionState {
  /** Shared questions ticked, by library question id. */
  library: string[];
  /** My questions ticked, by personal question id. */
  personal: string[];
  inline: InlineDraft[];
  /**
   * The preset whose tab's Select all was last used, or the saved report's
   * label; null after that tab's Clear, or on a report saved without one.
   * The server keeps it only while the shared selection still matches.
   */
  presetClicked: PresetKey | null;
}

export const emptySelection = (): QuestionSelectionState => ({ library: [], personal: [], inline: [], presetClicked: null });

/** The saved report's questions as the checklist holds them. */
export function selectionFromDetail(detail: ReportDetail): QuestionSelectionState {
  return {
    library: detail.questions.filter((q) => q.libraryQuestionId !== null).map((q) => q.libraryQuestionId!),
    personal: detail.questions.filter((q) => q.personalQuestionId !== null).map((q) => q.personalQuestionId!),
    inline: detail.questions
      .filter((q) => q.kind === "inline")
      .map((q) => ({ key: `saved:${q.questionId}`, text: q.text, save: false })),
    presetClicked: detail.presetKey,
  };
}

/** The library rows a preset names, by id, in library order; a row the library lacks is skipped. */
export function presetQuestionIds(key: PresetKey, library: LibraryQuestionView[]): string[] {
  const wanted = new Set(REPORT_PRESETS[key].questionKeys);
  return [...library]
    .filter((q) => wanted.has(q.key))
    .sort((a, b) => a.position - b.position)
    .map((q) => q.libraryQuestionId);
}

/**
 * Select all on a preset's tab: tick that preset's enabled questions, keep
 * every other tick. The selection is ONE set shared across the tabs, so
 * ticking the standard twenty and then Select all on Daily changes nothing
 * but the label candidate.
 */
export function selectTab(state: QuestionSelectionState, key: PresetKey, library: LibraryQuestionView[]): QuestionSelectionState {
  const enabled = new Set(library.filter((q) => q.enabled).map((q) => q.libraryQuestionId));
  const have = new Set(state.library);
  const added = presetQuestionIds(key, library).filter((id) => enabled.has(id) && !have.has(id));
  return { ...state, library: [...state.library, ...added], presetClicked: key };
}

/**
 * Clear on a preset's tab: untick that preset's questions and nothing else.
 * Clearing Daily leaves the fourteen standard questions Daily does not
 * share; My questions and the custom ones are never touched by either
 * button.
 */
export function clearTab(state: QuestionSelectionState, key: PresetKey, library: LibraryQuestionView[]): QuestionSelectionState {
  const drop = new Set(presetQuestionIds(key, library));
  return {
    ...state,
    library: state.library.filter((id) => !drop.has(id)),
    presetClicked: state.presetClicked === key ? null : state.presetClicked,
  };
}

export function toggleLibrary(state: QuestionSelectionState, libraryQuestionId: string, on: boolean): QuestionSelectionState {
  const without = state.library.filter((id) => id !== libraryQuestionId);
  return { ...state, library: on ? [...without, libraryQuestionId] : without };
}

export function togglePersonal(state: QuestionSelectionState, personalQuestionId: string, on: boolean): QuestionSelectionState {
  const without = state.personal.filter((id) => id !== personalQuestionId);
  return { ...state, personal: on ? [...without, personalQuestionId] : without };
}

export function addInline(state: QuestionSelectionState, text: string, save = false): QuestionSelectionState {
  const trimmed = text.trim();
  if (trimmed.length === 0) return state;
  const key = `new:${Date.now()}:${state.inline.length}`;
  return { ...state, inline: [...state.inline, { key, text: trimmed, save }] };
}

export function removeInline(state: QuestionSelectionState, key: string): QuestionSelectionState {
  return { ...state, inline: state.inline.filter((d) => d.key !== key) };
}

export function setInlineSave(state: QuestionSelectionState, key: string, save: boolean): QuestionSelectionState {
  return { ...state, inline: state.inline.map((d) => (d.key === key ? { ...d, save } : d)) };
}

/** The shared questions ticked, as library keys in library order - what the preset label is judged on. */
export function libraryKeysOf(state: QuestionSelectionState, library: LibraryQuestionView[]): string[] {
  const ticked = new Set(state.library);
  return [...library]
    .filter((q) => ticked.has(q.libraryQuestionId))
    .sort((a, b) => a.position - b.position)
    .map((q) => q.key);
}

/** The preset label the server will store for this selection, or null. */
export function presetLabelFor(state: QuestionSelectionState, library: LibraryQuestionView[]): PresetKey | null {
  return presetMatching(libraryKeysOf(state, library), state.presetClicked);
}

/** The body the create and update APIs take: shared, then mine, then typed. The server re-sorts the shared part anyway. */
export function selectionBody(state: QuestionSelectionState, library: LibraryQuestionView[]): QuestionSelection {
  const byId = new Map(library.map((q) => [q.libraryQuestionId, q.position]));
  const shared = [...state.library].sort((a, b) => (byId.get(a) ?? 0) - (byId.get(b) ?? 0));
  return [
    ...shared.map((libraryQuestionId) => ({ kind: "library" as const, libraryQuestionId })),
    ...state.personal.map((personalQuestionId) => ({ kind: "personal" as const, personalQuestionId })),
    ...state.inline.map((d) => ({ kind: "inline" as const, text: d.text, ...(d.save ? { saveToLibrary: true } : {}) })),
  ];
}

export function countSelection(state: QuestionSelectionState): number {
  return state.library.length + state.personal.length + state.inline.length;
}

/** "22 questions · Standard weekly health report + 2 custom", or "No questions ticked". */
export function describeSelection(state: QuestionSelectionState, library: LibraryQuestionView[]): string {
  const count = countSelection(state);
  if (count === 0) return "No questions ticked";
  const preset = presetLabelFor(state, library);
  const custom = state.personal.length + state.inline.length;
  const parts = [`${count} question${count === 1 ? "" : "s"}`];
  if (preset !== null) parts.push(REPORT_PRESETS[preset].label + (custom > 0 ? ` + ${custom} custom` : ""));
  else if (custom > 0 && state.library.length > 0) parts.push(`${state.library.length} shared + ${custom} custom`);
  else if (custom > 0) parts.push(`${custom} custom`);
  return parts.join(" · ");
}


/** The label beside a shared question: its section, how it is answered, and what it applies to. */
export function questionMeta(q: Pick<LibraryQuestionView, "sectionLabel" | "kind" | "appliesToLabel">): string {
  return `${q.sectionLabel} · ${q.kind} · ${q.appliesToLabel}`;
}

export interface SelectedQuestion {
  kind: "library" | "personal" | "inline";
  text: string;
  meta: string;
}

/**
 * The whole selection in the order the report will hold it - shared in
 * library order, then My questions, then typed - for the "Show selected"
 * list, which is the one place the full set is seen whichever tab is open.
 */
export function orderedSelection(
  state: QuestionSelectionState,
  library: LibraryQuestionView[],
  personal: PersonalQuestionView[],
): SelectedQuestion[] {
  const ticked = new Set(state.library);
  const mine = new Map(personal.map((p) => [p.personalQuestionId, p.text]));
  return [
    ...[...library]
      .filter((q) => ticked.has(q.libraryQuestionId))
      .sort((a, b) => a.position - b.position)
      .map((q) => ({ kind: "library" as const, text: q.text, meta: `Q${q.position} · ${questionMeta(q)}` })),
    ...state.personal.map((id) => ({ kind: "personal" as const, text: mine.get(id) ?? "(a question of the owner's)", meta: "my question · planner" })),
    ...state.inline.map((d) => ({ kind: "inline" as const, text: d.text, meta: d.save ? "this report only · planner · saved for reuse on save" : "this report only · planner" })),
  ];
}
