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
import type { ScheduleSpec } from "@/lib/modules/bas/reports/schedule";
import type { RunsList } from "@/lib/modules/bas/reports/runs-service";
import { formatInZone } from "@/lib/modules/bas/reports/schedule";
import type {
  AddRecipientInput,
  AddReportQuestionInput,
  CreateReportInput,
  ReportStateAction,
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

export const addQuestion = (reportId: string, body: AddReportQuestionInput) =>
  call<{ questionId: string }>(`/${encodeURIComponent(reportId)}/questions`, json("POST", body));
export const removeQuestion = (reportId: string, questionId: string) =>
  call<{ removed: boolean }>(
    `/${encodeURIComponent(reportId)}/questions/${encodeURIComponent(questionId)}`,
    { method: "DELETE" },
  );
export const reorderQuestions = (reportId: string, questionIds: string[]) =>
  call<{ reordered: boolean }>(`/${encodeURIComponent(reportId)}/questions`, json("PUT", { questionIds }));

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
