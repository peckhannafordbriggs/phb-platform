import { Prisma } from "@/lib/generated/prisma/client";
import { hasModuleAdmin, type Viewer } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { writeAuditEvent, type AuditAction } from "@/lib/audit";
import { BAS_MODULE_KEY } from "../constants";
import { BasError } from "../errors";
import { basSiteScope } from "../service";
import { SETTINGS_ROW_ID, type SafetyCeilingView } from "./ceiling";
import { readSafetyCeiling } from "./ceiling-read";
import { enqueueRun } from "./engine/queue";
import {
  describeRequiredRoles,
  parseRoleRequirements,
  sectionLabel,
  type LibraryQuestionKind,
} from "./library";
import { isPresetKey, presetLabel, presetMatching, type PresetKey } from "./presets";
import { isExternalAddress, normaliseEmail, COMPANY_EMAIL_DOMAIN } from "./recipients";
import {
  computeNextRun,
  describeSchedule,
  isAnalysisWindow,
  readScheduleSpec,
  scheduleParamsOf,
  scheduleProblem,
  type AnalysisWindow,
  type ScheduleSpec,
} from "./schedule";
import {
  isReportState,
  type LastRunView,
  type LibraryQuestionView,
  type OwnerOption,
  type OwnerTransfer,
  type PersonalQuestionView,
  type RecipientView,
  type ReportDetail,
  type ReportOptions,
  type ReportQuestionView,
  type ReportSiteOption,
  type ReportState,
  type ReportStateChange,
  type ReportSummary,
  type ReportsList,
} from "./types";
import type {
  AddRecipientInput,
  CreateReportInput,
  QuestionSelection,
  ReportStateAction,
  SafetyCeilingInput,
  TransferOwnerInput,
  UpdateReportInput,
} from "@/lib/validation/bas-reports";

/**
 * Report definitions, the shared and personal libraries, recipients, and
 * the module's safety ceiling (Reports, Phase 1; the ceiling 2026-11-12).
 * No runs: nothing here reads a reading.
 *
 * EMPLOYEE-PARAMETERISED, like the rest of the module. Every function takes
 * the viewer and decides what they may see before it reads anything, and the
 * decision is one function, `loadVisibleReport`: the OWNER, or an employee
 * whose BAS grant carries the module-admin flag. Everyone else gets
 * `report_not_found`, which the route renders as 404 - the plan's "everything
 * else 404 per module convention". When per-site grants arrive, `basSiteScope`
 * is already consulted here and that is the one place they land.
 *
 * THE OWNER IS NEVER A RECIPIENT ROW. The sender (Phase 4) adds the owner's
 * address from the employee record at send time. This file refuses the
 * owner's address on the way in (`addReportRecipient`) and on the way out
 * (`removeReportRecipient`), so no API path can make the owner optional.
 *
 * THE QUESTIONS ARE A SELECTION (2026-11-12). A report's questions arrive
 * whole, on create and on update, as the editor's checklist holds them,
 * and are stored in one canonical order: shared questions in library order,
 * then the owner's own, then typed ones. A preset is a button that ticks a
 * set; `preset_key` is a label of which was last clicked, kept while the
 * shared part still matches it, and restricts nothing. There is no
 * per-question route and nothing is locked.
 *
 * Every write records an audit event in the same transaction, with the
 * report's name in the metadata because the row may since be renamed or gone.
 */

type Tx = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

/**
 * The module-admin flag, read for an authorization decision.
 *
 * `hasModuleAdmin` is documented as the flag "for a caller that has already
 * passed requireModuleAccess" and as not being a boundary on its own. Here it
 * is called by a service that is reached only through `withBas`, which ran
 * `requireModuleAccess` first - so the two calls together ARE
 * `requireModuleAdmin`, evaluated inside the service rather than at the
 * route, because a report is visible to its owner OR a module admin and a
 * route-level guard cannot express an OR with a row it has not read yet.
 */
async function canAdminister(viewer: Viewer): Promise<boolean> {
  return hasModuleAdmin(viewer.id, BAS_MODULE_KEY);
}

function parseId(text: string): bigint | null {
  return /^[0-9]{1,20}$/.test(text) ? BigInt(text) : null;
}

const notFound = () =>
  new BasError("report_not_found", "That report does not exist, or you do not have access to it.");

const DETAIL_INCLUDE = {
  owner: { select: { id: true, email: true, firstName: true, lastName: true } },
  site: {
    select: {
      siteId: true,
      name: true,
      timezone: true,
      stations: {
        select: { stationId: true, displayName: true, niagaraStationName: true },
        orderBy: { stationId: "asc" },
      },
    },
  },
  questions: {
    orderBy: { position: "asc" },
    include: {
      libraryQuestion: {
        select: {
          libraryQuestionId: true,
          key: true,
          section: true,
          text: true,
          kind: true,
          appliesToLabel: true,
        },
      },
      personalQuestion: { select: { personalQuestionId: true, text: true } },
    },
  },
  recipients: {
    orderBy: { createdAt: "asc" },
    include: { addedBy: { select: { email: true } } },
  },
  // The newest run, for the list's Last run cell (Phase 3). One row, so a
  // report with a thousand runs costs the list nothing more.
  runs: {
    orderBy: [{ createdAt: "desc" }, { runId: "desc" }],
    take: 1,
    select: { runId: true, status: true, createdAt: true, startedAt: true, finishedAt: true, partialReason: true, error: true },
  },
} satisfies Prisma.BasReportDefinitionInclude;

type DetailRow = Prisma.BasReportDefinitionGetPayload<{ include: typeof DETAIL_INCLUDE }>;

/**
 * The report, or `report_not_found`. Owner or module admin; and the building
 * must be within the viewer's site entitlement, which today is every site.
 */
async function loadVisibleReport(
  viewer: Viewer,
  reportIdText: string,
  db: Tx | typeof prisma = prisma,
): Promise<{ row: DetailRow; admin: boolean }> {
  const reportId = parseId(reportIdText);
  if (reportId === null) throw notFound();

  const row = await db.basReportDefinition.findUnique({
    where: { reportId },
    include: DETAIL_INCLUDE,
  });
  if (row === null) throw notFound();

  const admin = await canAdminister(viewer);
  if (row.ownerEmployeeId !== viewer.id && !admin) throw notFound();

  const { entitled } = await basSiteScope(viewer);
  if (entitled !== null && !entitled.includes(row.siteId)) throw notFound();

  return { row, admin };
}

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

function personName(p: { firstName: string; lastName: string; email: string }): string {
  const full = `${p.firstName} ${p.lastName}`.trim();
  return full.length > 0 ? full : p.email;
}

function stationName(s: { displayName: string | null; niagaraStationName: string }): string {
  return s.displayName ?? s.niagaraStationName;
}

function toWindow(value: string): AnalysisWindow {
  return isAnalysisWindow(value) ? value : "7d";
}

function toState(value: string): ReportState {
  return isReportState(value) ? value : "draft";
}

/** The schedule in words, or a plain statement that the stored one is unreadable. */
function scheduleWords(
  spec: ScheduleSpec | null,
  timeOfDay: string,
  timezone: string,
  window: AnalysisWindow,
): string {
  return spec === null
    ? "Schedule could not be read - open the report and set it again"
    : describeSchedule(spec, timeOfDay, timezone, window);
}

function toSummary(row: DetailRow, viewer: Viewer, stationsOnSite: number): ReportSummary {
  const window = toWindow(row.analysisWindow);
  const spec = readScheduleSpec(row.scheduleKind, row.scheduleParams);
  return {
    reportId: row.reportId.toString(),
    name: row.name,
    description: row.description,
    ownerEmployeeId: row.ownerEmployeeId,
    ownerName: personName(row.owner),
    ownerEmail: row.owner.email,
    isOwner: row.ownerEmployeeId === viewer.id,
    site: { siteId: row.siteId.toString(), name: row.site.name, timezone: row.site.timezone },
    stationsSelected: row.stationIds.length,
    stationsOnSite,
    presetKey: isPresetKey(row.presetKey) ? row.presetKey : null,
    presetLabel: presetLabel(row.presetKey),
    analysisWindow: window,
    schedule: spec,
    timeOfDay: row.timeOfDay,
    scheduleText: scheduleWords(spec, row.timeOfDay, row.site.timezone, window),
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    state: toState(row.state),
    questionCount: row.questions.length,
    recipientCount: row.recipients.length,
    lastRun: lastRunView(row.runs[0]),
    pausedReason: row.pausedReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function lastRunView(run: DetailRow["runs"][number] | undefined): LastRunView | null {
  if (run === undefined) return null;
  const status = run.status;
  return {
    runId: run.runId.toString(),
    status: status === "queued" || status === "running" || status === "succeeded" || status === "partial" ? status : "failed",
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    partialReason: run.partialReason,
    error: run.error,
  };
}

function toQuestionView(q: DetailRow["questions"][number]): ReportQuestionView {
  const kind = q.kind === "library" || q.kind === "personal" ? q.kind : "inline";
  const lib = q.libraryQuestion;
  return {
    questionId: q.questionId.toString(),
    position: q.position,
    kind,
    text: lib?.text ?? q.personalQuestion?.text ?? q.inlineText ?? "",
    libraryQuestionId: lib?.libraryQuestionId.toString() ?? null,
    libraryKey: lib?.key ?? null,
    section: lib?.section ?? null,
    sectionLabel: lib === null ? null : sectionLabel(lib.section),
    libraryKind: lib === null ? null : (lib.kind as LibraryQuestionKind),
    appliesToLabel: lib?.appliesToLabel ?? null,
    personalQuestionId: q.personalQuestion?.personalQuestionId.toString() ?? null,
  };
}

function toRecipientView(r: DetailRow["recipients"][number]): RecipientView {
  return {
    email: r.email,
    isExternal: r.isExternal,
    confirmedAt: r.confirmedAt?.toISOString() ?? null,
    addedBy: r.addedBy?.email ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

function toDetail(row: DetailRow, viewer: Viewer): ReportDetail {
  const selected = new Set(row.stationIds.map((id) => id.toString()));
  return {
    ...toSummary(row, viewer, row.site.stations.length),
    stationIds: [...selected],
    stations: row.site.stations.map((s) => ({
      stationId: s.stationId.toString(),
      name: stationName(s),
      selected: selected.has(s.stationId.toString()),
    })),
    questions: row.questions.map(toQuestionView),
    recipients: row.recipients.map(toRecipientView),
  };
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

async function audit(
  tx: Tx,
  action: AuditAction,
  viewer: Viewer,
  metadata: Record<string, unknown>,
): Promise<void> {
  await writeAuditEvent(tx, {
    action,
    actorEmployeeId: viewer.id,
    moduleKey: BAS_MODULE_KEY,
    metadata,
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function listReports(viewer: Viewer): Promise<ReportsList> {
  const admin = await canAdminister(viewer);
  const { entitled } = await basSiteScope(viewer);

  const where: Prisma.BasReportDefinitionWhereInput = {
    ...(admin ? {} : { ownerEmployeeId: viewer.id }),
    ...(entitled === null ? {} : { siteId: { in: entitled } }),
  };

  const [rows, reportsInDatabase] = await Promise.all([
    prisma.basReportDefinition.findMany({
      where,
      include: DETAIL_INCLUDE,
      // Name, then id: the tiebreak is load-bearing on every paged list in
      // this platform, and this one will be paged the day it needs to be.
      orderBy: [{ name: "asc" }, { reportId: "asc" }],
    }),
    // Counted without the include, so a join that drops a row is visible.
    prisma.basReportDefinition.count({ where }),
  ]);

  return {
    reports: rows.map((row) => toSummary(row, viewer, row.site.stations.length)),
    reportsInDatabase,
    canAdminister: admin,
    viewerEmployeeId: viewer.id,
  };
}

export async function getReport(viewer: Viewer, reportIdText: string): Promise<ReportDetail> {
  const { row } = await loadVisibleReport(viewer, reportIdText);
  return toDetail(row, viewer);
}

/**
 * The buildings the viewer may report on, each with its stations; the two
 * defaults; and, for a module admin, the employees a report can be handed
 * to (Phase 3) - active, holding the BAS grant.
 */
export async function listReportOptions(viewer: Viewer): Promise<ReportOptions> {
  const { entitled } = await basSiteScope(viewer);
  const admin = await canAdminister(viewer);
  const sites = await prisma.basSite.findMany({
    where: entitled === null ? {} : { siteId: { in: entitled } },
    select: {
      siteId: true,
      name: true,
      timezone: true,
      project: { select: { name: true } },
      stations: {
        select: { stationId: true, displayName: true, niagaraStationName: true },
        orderBy: { stationId: "asc" },
      },
    },
    orderBy: [{ name: "asc" }, { siteId: "asc" }],
  });

  const options: ReportSiteOption[] = sites.map((s) => ({
    siteId: s.siteId.toString(),
    name: s.name,
    timezone: s.timezone,
    projectName: s.project.name,
    stations: s.stations.map((st) => ({ stationId: st.stationId.toString(), name: stationName(st) })),
  }));

  const owners: OwnerOption[] = admin
    ? (
        await prisma.employee.findMany({
          where: { status: "active", grants: { some: { moduleKey: BAS_MODULE_KEY } } },
          select: { id: true, email: true, firstName: true, lastName: true },
          orderBy: [{ lastName: "asc" }, { firstName: "asc" }, { email: "asc" }],
        })
      ).map((e) => ({ employeeId: e.id, name: personName(e), email: e.email }))
    : [];

  return {
    sites: options,
    companyEmailDomain: COMPANY_EMAIL_DOMAIN,
    canAdminister: admin,
    owners,
  };
}

// ---------------------------------------------------------------------------
// The shared library
// ---------------------------------------------------------------------------

export async function listLibraryQuestions(): Promise<LibraryQuestionView[]> {
  const rows = await prisma.basLibraryQuestion.findMany({
    include: { addedBy: { select: { email: true } } },
    orderBy: [{ position: "asc" }, { libraryQuestionId: "asc" }],
  });
  return rows.map((r) => {
    const requiredRoles = parseRoleRequirements(r.requiredRoles);
    return {
      libraryQuestionId: r.libraryQuestionId.toString(),
      key: r.key,
      section: r.section,
      sectionLabel: sectionLabel(r.section),
      position: r.position,
      text: r.text,
      kind: r.kind === "planner" ? "planner" : "computed",
      analysisFn: r.analysisFn,
      appliesToLabel: r.appliesToLabel,
      appliesToEquipment: r.appliesToEquipment,
      requiredRoles,
      requiredRolesText: describeRequiredRoles(requiredRoles),
      minCoverage: Number(r.minCoverage),
      enabled: r.enabled,
      addedBy: r.addedBy?.email ?? null,
      createdAt: r.createdAt.toISOString(),
    };
  });
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

async function assertSiteVisible(viewer: Viewer, siteIdText: string): Promise<{ siteId: bigint; name: string; timezone: string }> {
  const siteId = parseId(siteIdText);
  const { entitled } = await basSiteScope(viewer);
  const site =
    siteId === null
      ? null
      : await prisma.basSite.findUnique({ where: { siteId }, select: { siteId: true, name: true, timezone: true } });
  if (site === null || (entitled !== null && !entitled.includes(site.siteId))) {
    throw new BasError("site_not_found", "That building does not exist, or you do not have access to it.");
  }
  return site;
}

/** Every station in the subset must be on the report's building. */
async function assertStationsOnSite(siteId: bigint, stationIdTexts: string[]): Promise<bigint[]> {
  const ids = [...new Set(stationIdTexts)].map((t) => parseId(t));
  if (ids.some((id) => id === null)) {
    throw new BasError("station_other_building", "One of the chosen stations is not a valid id.");
  }
  const wanted = ids as bigint[];
  if (wanted.length === 0) return [];
  const found = await prisma.basStation.count({ where: { stationId: { in: wanted }, siteId } });
  if (found !== wanted.length) {
    throw new BasError(
      "station_other_building",
      `${wanted.length - found} of the chosen stations ${wanted.length - found === 1 ? "is" : "are"} not on this building.`,
    );
  }
  return wanted;
}

async function assertNameFree(ownerEmployeeId: string, name: string, exceptReportId: bigint | null): Promise<void> {
  const clash = await prisma.basReportDefinition.findFirst({
    where: {
      ownerEmployeeId,
      name: { equals: name, mode: "insensitive" },
      ...(exceptReportId === null ? {} : { reportId: { not: exceptReportId } }),
    },
    select: { reportId: true },
  });
  if (clash !== null) {
    throw new BasError("name_taken", `You already have a report named "${name}".`);
  }
}

function assertSchedule(spec: ScheduleSpec): void {
  const problem = scheduleProblem(spec);
  if (problem !== null) throw new BasError("invalid_schedule", problem);
}

export async function createReport(viewer: Viewer, input: CreateReportInput): Promise<{ reportId: string }> {
  const site = await assertSiteVisible(viewer, input.siteId);
  const stationIds = await assertStationsOnSite(site.siteId, input.stationIds ?? []);
  assertSchedule(input.schedule);
  await assertNameFree(viewer.id, input.name, null);

  const reportId = await prisma.$transaction(async (tx) => {
    const created = await tx.basReportDefinition.create({
      data: {
        ownerEmployeeId: viewer.id,
        name: input.name,
        description: input.description ?? null,
        siteId: site.siteId,
        stationIds,
        presetKey: null,
        analysisWindow: input.analysisWindow ?? "7d",
        scheduleKind: input.schedule.kind,
        scheduleParams: scheduleParamsOf(input.schedule) as Prisma.InputJsonValue,
        timeOfDay: input.timeOfDay,
        state: "draft",
      },
      select: { reportId: true },
    });

    // The selection, then the label it earns. The viewer is the owner, so
    // their own questions and "save for reuse" are allowed.
    const resolved = await resolveSelection(tx, viewer, input.questions ?? [], null, created.reportId);
    await writeQuestions(tx, created.reportId, resolved.rows);
    const presetKey = presetMatching(resolved.libraryKeys, input.presetKey ?? null);
    if (presetKey !== null) {
      await tx.basReportDefinition.update({ where: { reportId: created.reportId }, data: { presetKey } });
    }

    await audit(tx, "bas.report_created", viewer, {
      reportId: created.reportId.toString(),
      name: input.name,
      siteId: site.siteId.toString(),
      siteName: site.name,
      presetKey,
      questions: resolved.rows.length,
      ...resolved.counts,
      scheduleKind: input.schedule.kind,
      timeOfDay: input.timeOfDay,
      analysisWindow: input.analysisWindow ?? "7d",
    });

    return created.reportId;
  });

  return { reportId: reportId.toString() };
}

export async function updateReport(
  viewer: Viewer,
  reportIdText: string,
  input: UpdateReportInput,
): Promise<{ changed: boolean; nextRunAt: string | null }> {
  const { row } = await loadVisibleReport(viewer, reportIdText);

  const data: Prisma.BasReportDefinitionUpdateInput = {};
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  let siteId = row.siteId;
  let timezone = row.site.timezone;

  if (input.siteId !== undefined && input.siteId !== row.siteId.toString()) {
    const site = await assertSiteVisible(viewer, input.siteId);
    siteId = site.siteId;
    timezone = site.timezone;
    data.site = { connect: { siteId } };
    changes.siteId = { from: row.siteId.toString(), to: siteId.toString() };
    // A new building means a new set of stations; an old subset cannot apply.
    if (input.stationIds === undefined) {
      data.stationIds = [];
      changes.stationIds = { from: row.stationIds.map(String), to: [] };
    }
  }

  if (input.stationIds !== undefined) {
    const ids = await assertStationsOnSite(siteId, input.stationIds);
    const before = row.stationIds.map(String).sort();
    const after = ids.map(String).sort();
    if (before.join(",") !== after.join(",")) {
      data.stationIds = ids;
      changes.stationIds = { from: before, to: after };
    }
  }

  if (input.name !== undefined && input.name !== row.name) {
    await assertNameFree(row.ownerEmployeeId, input.name, row.reportId);
    data.name = input.name;
    changes.name = { from: row.name, to: input.name };
  }

  if (input.description !== undefined && input.description !== row.description) {
    data.description = input.description;
    changes.description = { from: row.description, to: input.description };
  }

  if (input.analysisWindow !== undefined && input.analysisWindow !== row.analysisWindow) {
    data.analysisWindow = input.analysisWindow;
    changes.analysisWindow = { from: row.analysisWindow, to: input.analysisWindow };
  }

  let spec = readScheduleSpec(row.scheduleKind, row.scheduleParams);
  let timeOfDay = row.timeOfDay;
  if (input.schedule !== undefined && input.timeOfDay !== undefined) {
    assertSchedule(input.schedule);
    const params = scheduleParamsOf(input.schedule);
    const same =
      input.schedule.kind === row.scheduleKind &&
      input.timeOfDay === row.timeOfDay &&
      JSON.stringify(params) === JSON.stringify(row.scheduleParams);
    if (!same) {
      data.scheduleKind = input.schedule.kind;
      data.scheduleParams = params as Prisma.InputJsonValue;
      data.timeOfDay = input.timeOfDay;
      changes.schedule = {
        from: { kind: row.scheduleKind, params: row.scheduleParams, timeOfDay: row.timeOfDay },
        to: { kind: input.schedule.kind, params, timeOfDay: input.timeOfDay },
      };
      spec = input.schedule;
      timeOfDay = input.timeOfDay;
    }
  }

  // An active report whose clock inputs moved gets a new next run, computed
  // from the new local time and the building's zone - never by shifting the
  // old instant.
  let nextRunAt: Date | null = row.nextRunAt;
  const clockMoved = changes.schedule !== undefined || changes.siteId !== undefined;
  if (row.state === "active" && clockMoved) {
    if (spec === null) {
      throw new BasError("invalid_schedule", "The stored schedule could not be read. Set it again.");
    }
    nextRunAt = computeNextRun(spec, timeOfDay, timezone, new Date());
    data.nextRunAt = nextRunAt;
    changes.nextRunAt = { from: row.nextRunAt?.toISOString() ?? null, to: nextRunAt.toISOString() };
  }

  // The questions and the preset label, decided together: the label is
  // whichever preset was last clicked (sent, or the stored one), kept only
  // while the shared questions match it. A selection sent unchanged is no
  // change; a preset sent alone never alters the questions.
  const clicked: PresetKey | null = input.presetKey !== undefined ? input.presetKey : (isPresetKey(row.presetKey) ? row.presetKey : null);
  const currentSignature = row.questions.map(questionSignature).join("\n");
  let selection: Awaited<ReturnType<typeof resolveSelection>> | null = null;
  let libraryKeys = row.questions.filter((q) => q.libraryQuestion !== null).map((q) => q.libraryQuestion!.key);

  const result = await prisma.$transaction(async (tx) => {
    if (input.questions !== undefined) {
      selection = await resolveSelection(tx, viewer, input.questions, row, row.reportId);
      libraryKeys = selection.libraryKeys;
      if (selection.rows.map(rowSignature).join("\n") === currentSignature) selection = null;
    }
    const presetKey = presetMatching(libraryKeys, clicked);
    if (presetKey !== row.presetKey) {
      data.presetKey = presetKey;
      changes.presetKey = { from: row.presetKey, to: presetKey };
    }

    if (Object.keys(changes).length === 0 && selection === null) {
      return { changed: false };
    }

    if (Object.keys(data).length > 0) {
      await tx.basReportDefinition.update({ where: { reportId: row.reportId }, data });
    }
    if (selection !== null) {
      await writeQuestions(tx, row.reportId, selection.rows);
      await audit(tx, "bas.report_questions_changed", viewer, {
        reportId: row.reportId.toString(),
        name: input.name ?? row.name,
        change: "set",
        presetKey,
        count: selection.rows.length,
        ...selection.counts,
      });
    }
    if (Object.keys(changes).length > 0) {
      await audit(tx, "bas.report_updated", viewer, {
        reportId: row.reportId.toString(),
        name: input.name ?? row.name,
        previousName: row.name,
        changes,
      });
    }
    return { changed: true };
  });

  return { changed: result.changed, nextRunAt: nextRunAt?.toISOString() ?? null };
}

export async function deleteReport(viewer: Viewer, reportIdText: string): Promise<{ deleted: boolean }> {
  const { row } = await loadVisibleReport(viewer, reportIdText);
  // Runs are kept indefinitely (plan §A, Limits). A report with history is
  // paused, not deleted; the foreign key is RESTRICT and this says why.
  const runs = await prisma.basReportRun.count({ where: { reportId: row.reportId } });
  if (runs > 0) {
    throw new BasError(
      "report_has_runs",
      `This report has ${runs} run${runs === 1 ? "" : "s"} and its history is kept. Pause it instead of deleting it.`,
    );
  }
  await prisma.$transaction(async (tx) => {
    // Questions and recipients cascade from the definition.
    await tx.basReportDefinition.delete({ where: { reportId: row.reportId } });
    await audit(tx, "bas.report_deleted", viewer, {
      reportId: row.reportId.toString(),
      name: row.name,
      siteName: row.site.name,
      state: row.state,
      questions: row.questions.length,
      recipients: row.recipients.length,
    });
  });
  return { deleted: true };
}

// ---------------------------------------------------------------------------
// The state machine: draft -> active <-> paused
// ---------------------------------------------------------------------------

export async function changeReportState(
  viewer: Viewer,
  reportIdText: string,
  action: ReportStateAction,
): Promise<ReportStateChange> {
  const { row } = await loadVisibleReport(viewer, reportIdText);
  const from = toState(row.state);

  let to: ReportState;
  let nextRunAt: Date | null;

  switch (action) {
    case "activate":
    case "resume": {
      const allowedFrom: ReportState[] = action === "activate" ? ["draft", "paused"] : ["paused"];
      if (!allowedFrom.includes(from)) {
        throw new BasError(
          "invalid_state",
          from === "paused_owner_disabled"
            ? "This report was paused because its owner's account is disabled. A module admin has to reassign the owner before it can run again."
            : from === "active"
              ? "This report is already active."
              : `A ${from} report cannot be ${action === "activate" ? "activated" : "resumed"}.`,
        );
      }
      if (row.questions.length === 0) {
        throw new BasError("report_not_ready", "Add at least one question before activating the report.");
      }
      const spec = readScheduleSpec(row.scheduleKind, row.scheduleParams);
      if (spec === null || scheduleProblem(spec) !== null) {
        throw new BasError("report_not_ready", "The schedule could not be read. Set it again before activating.");
      }
      to = "active";
      nextRunAt = computeNextRun(spec, row.timeOfDay, row.site.timezone, new Date());
      break;
    }
    case "pause": {
      if (from !== "active") {
        throw new BasError("invalid_state", `Only an active report can be paused; this one is ${from}.`);
      }
      to = "paused";
      // Cleared, so a paused report never shows a next run that will not happen.
      nextRunAt = null;
      break;
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.basReportDefinition.update({
      where: { reportId: row.reportId },
      data: { state: to, nextRunAt },
    });
    await audit(tx, "bas.report_state_changed", viewer, {
      reportId: row.reportId.toString(),
      name: row.name,
      from,
      to,
      nextRunAt: nextRunAt?.toISOString() ?? null,
    });
  });

  return { state: to, nextRunAt: nextRunAt?.toISOString() ?? null };
}

// ---------------------------------------------------------------------------
// The questions on a report: one selection, one canonical order
// ---------------------------------------------------------------------------

/** One row to store, resolved and validated. */
interface ResolvedQuestion {
  kind: "library" | "personal" | "inline";
  libraryQuestionId: bigint | null;
  personalQuestionId: bigint | null;
  inlineText: string | null;
}

interface ResolvedSelection {
  /** In the order they are stored: library by position, then personal, then inline. */
  rows: ResolvedQuestion[];
  /** The shared questions' keys, in stored order - what the preset label is judged on. */
  libraryKeys: string[];
  counts: { library: number; personal: number; inline: number };
}

/** The identity of a stored row, for "did the selection change". */
function questionSignature(q: DetailRow["questions"][number]): string {
  return `${q.kind}:${q.libraryQuestionId ?? ""}:${q.personalQuestionId ?? ""}:${q.inlineText ?? ""}`;
}
function rowSignature(r: ResolvedQuestion): string {
  return `${r.kind}:${r.libraryQuestionId ?? ""}:${r.personalQuestionId ?? ""}:${r.inlineText ?? ""}`;
}

/**
 * Validate a selection and put it in its canonical order.
 *
 * `existing` is the report being edited, or null on create. It matters in
 * two places: a shared question that has since been turned off stays
 * allowed while it is already on this report (a saved report never becomes
 * unsaveable), and a personal question that is already on the report stays
 * allowed whoever is saving - a module admin editing the owner's report
 * keeps the owner's own questions, and cannot add theirs
 * (`personal_question_not_owner`). "Save for reuse" on a typed question is
 * the owner's alone for the same reason: it writes the viewer's library.
 */
async function resolveSelection(
  tx: Tx,
  viewer: Viewer,
  selection: QuestionSelection,
  existing: DetailRow | null,
  reportId: bigint,
): Promise<ResolvedSelection> {
  const isOwner = existing === null || existing.ownerEmployeeId === viewer.id;
  const onReportLibrary = new Set((existing?.questions ?? []).map((q) => q.libraryQuestionId?.toString()).filter((id): id is string => id !== undefined));
  const onReportPersonal = new Set((existing?.questions ?? []).map((q) => q.personalQuestionId?.toString()).filter((id): id is string => id !== undefined));

  // Shared questions: looked up in one query, duplicates refused, disabled
  // ones refused unless already here, then sorted into library order.
  const libraryIds: bigint[] = [];
  const seenLibrary = new Set<string>();
  for (const item of selection) {
    if (item.kind !== "library") continue;
    const id = parseId(item.libraryQuestionId);
    if (id === null) throw new BasError("library_question_not_found", "That library question does not exist.");
    if (seenLibrary.has(id.toString())) throw new BasError("question_exists", "A shared question is ticked twice.");
    seenLibrary.add(id.toString());
    libraryIds.push(id);
  }
  const libraryRows =
    libraryIds.length === 0
      ? []
      : await tx.basLibraryQuestion.findMany({
          where: { libraryQuestionId: { in: libraryIds } },
          select: { libraryQuestionId: true, key: true, position: true, enabled: true },
        });
  const byId = new Map(libraryRows.map((r) => [r.libraryQuestionId.toString(), r]));
  for (const id of libraryIds) {
    const lib = byId.get(id.toString());
    if (lib === undefined) throw new BasError("library_question_not_found", "That library question does not exist.");
    if (!lib.enabled && !onReportLibrary.has(id.toString())) {
      throw new BasError("library_question_disabled", "That library question has been turned off.");
    }
  }
  const libraryOrdered = libraryIds
    .map((id) => byId.get(id.toString())!)
    .sort((a, b) => a.position - b.position || (a.libraryQuestionId < b.libraryQuestionId ? -1 : 1));

  // The viewer's own questions, in the order given.
  const personalIds: bigint[] = [];
  const seenPersonal = new Set<string>();
  for (const item of selection) {
    if (item.kind !== "personal") continue;
    const id = parseId(item.personalQuestionId);
    if (id === null) throw new BasError("personal_question_not_found", "That question is not in your library.");
    if (seenPersonal.has(id.toString())) throw new BasError("question_exists", "One of your questions is ticked twice.");
    seenPersonal.add(id.toString());
    personalIds.push(id);
  }
  const notYetOnReport = personalIds.filter((id) => !onReportPersonal.has(id.toString()));
  if (notYetOnReport.length > 0) {
    if (!isOwner) {
      throw new BasError(
        "personal_question_not_owner",
        "Personal questions go on your own reports only. Type the question in instead.",
      );
    }
    const mine = await tx.basPersonalQuestion.findMany({
      where: { personalQuestionId: { in: notYetOnReport }, employeeId: viewer.id },
      select: { personalQuestionId: true },
    });
    if (mine.length !== notYetOnReport.length) {
      throw new BasError("personal_question_not_found", "That question is not in your library.");
    }
  }

  // Typed questions, in the order given; "save for reuse" makes one personal.
  const inlineRows: ResolvedQuestion[] = [];
  for (const item of selection) {
    if (item.kind !== "inline") continue;
    if (item.saveToLibrary === true) {
      if (!isOwner) {
        throw new BasError(
          "personal_question_not_owner",
          "A question can be saved to your library only from your own report. Add it without saving.",
        );
      }
      const personal = await tx.basPersonalQuestion.create({
        data: { employeeId: viewer.id, text: item.text },
        select: { personalQuestionId: true, text: true },
      });
      await audit(tx, "bas.personal_question_created", viewer, {
        personalQuestionId: personal.personalQuestionId.toString(),
        text: personal.text,
        fromReportId: reportId.toString(),
      });
      personalIds.push(personal.personalQuestionId);
    } else {
      inlineRows.push({ kind: "inline", libraryQuestionId: null, personalQuestionId: null, inlineText: item.text });
    }
  }

  const rows: ResolvedQuestion[] = [
    ...libraryOrdered.map((lib) => ({ kind: "library" as const, libraryQuestionId: lib.libraryQuestionId, personalQuestionId: null, inlineText: null })),
    ...personalIds.map((id) => ({ kind: "personal" as const, libraryQuestionId: null, personalQuestionId: id, inlineText: null })),
    ...inlineRows,
  ];
  return {
    rows,
    libraryKeys: libraryOrdered.map((lib) => lib.key),
    counts: { library: libraryOrdered.length, personal: personalIds.length, inline: inlineRows.length },
  };
}

/** Replace a report's rows with the selection, positions 0..n-1 in its order. */
async function writeQuestions(tx: Tx, reportId: bigint, rows: ResolvedQuestion[]): Promise<void> {
  await tx.basReportQuestion.deleteMany({ where: { reportId } });
  if (rows.length === 0) return;
  await tx.basReportQuestion.createMany({
    data: rows.map((r, position) => ({
      reportId,
      position,
      kind: r.kind,
      libraryQuestionId: r.libraryQuestionId,
      personalQuestionId: r.personalQuestionId,
      inlineText: r.inlineText,
    })),
  });
}

// ---------------------------------------------------------------------------
// The personal library
// ---------------------------------------------------------------------------

async function usedInReports(employeeId: string, ids: bigint[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.basReportQuestion.findMany({
    where: { personalQuestionId: { in: ids } },
    select: { personalQuestionId: true, reportId: true },
    distinct: ["personalQuestionId", "reportId"],
  });
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = r.personalQuestionId!.toString();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export async function listPersonalQuestions(viewer: Viewer): Promise<PersonalQuestionView[]> {
  const rows = await prisma.basPersonalQuestion.findMany({
    where: { employeeId: viewer.id },
    orderBy: [{ createdAt: "desc" }, { personalQuestionId: "desc" }],
  });
  const used = await usedInReports(viewer.id, rows.map((r) => r.personalQuestionId));
  return rows.map((r) => ({
    personalQuestionId: r.personalQuestionId.toString(),
    text: r.text,
    usedInReports: used.get(r.personalQuestionId.toString()) ?? 0,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export async function createPersonalQuestion(viewer: Viewer, text: string): Promise<{ personalQuestionId: string }> {
  const id = await prisma.$transaction(async (tx) => {
    const created = await tx.basPersonalQuestion.create({
      data: { employeeId: viewer.id, text },
      select: { personalQuestionId: true },
    });
    await audit(tx, "bas.personal_question_created", viewer, {
      personalQuestionId: created.personalQuestionId.toString(),
      text,
    });
    return created.personalQuestionId;
  });
  return { personalQuestionId: id.toString() };
}

async function loadOwnPersonalQuestion(viewer: Viewer, idText: string) {
  const id = parseId(idText);
  const row =
    id === null
      ? null
      : await prisma.basPersonalQuestion.findFirst({ where: { personalQuestionId: id, employeeId: viewer.id } });
  if (row === null) throw new BasError("personal_question_not_found", "That question is not in your library.");
  return row;
}

export async function updatePersonalQuestion(
  viewer: Viewer,
  idText: string,
  text: string,
): Promise<{ changed: boolean }> {
  const row = await loadOwnPersonalQuestion(viewer, idText);
  if (row.text === text) return { changed: false };
  await prisma.$transaction(async (tx) => {
    await tx.basPersonalQuestion.update({ where: { personalQuestionId: row.personalQuestionId }, data: { text } });
    await audit(tx, "bas.personal_question_updated", viewer, {
      personalQuestionId: row.personalQuestionId.toString(),
      previousText: row.text,
      text,
    });
  });
  return { changed: true };
}

export async function deletePersonalQuestion(viewer: Viewer, idText: string): Promise<{ deleted: boolean }> {
  const row = await loadOwnPersonalQuestion(viewer, idText);
  const used = await usedInReports(viewer.id, [row.personalQuestionId]);
  const count = used.get(row.personalQuestionId.toString()) ?? 0;
  if (count > 0) {
    throw new BasError(
      "personal_question_in_use",
      `That question is still on ${count} report${count === 1 ? "" : "s"}. Remove it from them first.`,
    );
  }
  await prisma.$transaction(async (tx) => {
    await tx.basPersonalQuestion.delete({ where: { personalQuestionId: row.personalQuestionId } });
    await audit(tx, "bas.personal_question_deleted", viewer, {
      personalQuestionId: row.personalQuestionId.toString(),
      text: row.text,
    });
  });
  return { deleted: true };
}

// ---------------------------------------------------------------------------
// Recipients. The owner is never a row.
// ---------------------------------------------------------------------------

function assertNotOwner(row: DetailRow, email: string): void {
  if (normaliseEmail(row.owner.email) === email) {
    throw new BasError(
      "owner_is_recipient",
      "The report's owner always receives it and is not added or removed here.",
    );
  }
}

export async function addReportRecipient(
  viewer: Viewer,
  reportIdText: string,
  input: AddRecipientInput,
): Promise<RecipientView> {
  const { row } = await loadVisibleReport(viewer, reportIdText);
  const email = normaliseEmail(input.email);
  assertNotOwner(row, email);

  if (row.recipients.some((r) => r.email === email)) {
    throw new BasError("recipient_exists", `${email} already receives this report.`);
  }

  const isExternal = isExternalAddress(email);
  if (isExternal && input.confirmed !== true) {
    throw new BasError(
      "external_unconfirmed",
      `${email} is outside ${COMPANY_EMAIL_DOMAIN}. Confirm that this building's report should go there.`,
    );
  }

  const now = new Date();
  const created = await prisma.$transaction(async (tx) => {
    const r = await tx.basReportRecipient.create({
      data: {
        reportId: row.reportId,
        email,
        isExternal,
        addedById: viewer.id,
        confirmedById: isExternal ? viewer.id : null,
        confirmedAt: isExternal ? now : null,
      },
      include: { addedBy: { select: { email: true } } },
    });
    await audit(tx, "bas.report_recipient_added", viewer, {
      reportId: row.reportId.toString(),
      name: row.name,
      email,
      isExternal,
      confirmed: isExternal,
    });
    return r;
  });

  return toRecipientView(created);
}

export async function removeReportRecipient(
  viewer: Viewer,
  reportIdText: string,
  emailText: string,
): Promise<{ removed: boolean }> {
  const { row } = await loadVisibleReport(viewer, reportIdText);
  const email = normaliseEmail(emailText);
  assertNotOwner(row, email);

  const target = row.recipients.find((r) => r.email === email);
  if (target === undefined) {
    throw new BasError("recipient_not_found", `${email} does not receive this report.`);
  }

  await prisma.$transaction(async (tx) => {
    await tx.basReportRecipient.delete({ where: { recipientId: target.recipientId } });
    await audit(tx, "bas.report_recipient_removed", viewer, {
      reportId: row.reportId.toString(),
      name: row.name,
      email,
      isExternal: target.isExternal,
    });
  });
  return { removed: true };
}


// ---------------------------------------------------------------------------
// Runs on request, and the owner (Phase 3)
// ---------------------------------------------------------------------------

/**
 * Queue a run of this report now (Phase 3's "Run now"). Owner or module
 * admin - `loadVisibleReport` is the gate, and anyone else is told the report
 * does not exist. One run in flight per report: a second request while one is
 * queued or running is refused with `run_in_flight` and the row that is in the
 * way, so the screen can say so rather than queue a duplicate. The period is
 * the definition's window ending now; the worker picks the row up within its
 * polling interval.
 *
 * The in-flight check and the insert share a transaction on the locked
 * definition row, so two clicks in the same instant cannot both pass it.
 */
export async function requestRun(viewer: Viewer, reportIdText: string, now = new Date()): Promise<{ runId: string }> {
  const { row } = await loadVisibleReport(viewer, reportIdText);
  if (row.questions.length === 0) {
    throw new BasError("report_not_ready", "Add at least one question before running the report.");
  }

  const runId = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT report_id FROM bas_report_definitions WHERE report_id = ${row.reportId} FOR UPDATE`;
    const inFlight = await tx.basReportRun.findFirst({
      where: { reportId: row.reportId, status: { in: ["queued", "running"] } },
      orderBy: { runId: "desc" },
      select: { runId: true, status: true },
    });
    if (inFlight !== null) {
      throw new BasError(
        "run_in_flight",
        `A run of this report is already ${inFlight.status}. Wait for it to finish; it is on the Reports list.`,
      );
    }
    const run = await enqueueRun(tx, { reportId: row.reportId, trigger: "manual", periodEnd: now, startedById: viewer.id });
    await audit(tx, "bas.report_run_requested", viewer, {
      reportId: row.reportId.toString(),
      runId: run.runId.toString(),
      name: row.name,
      trigger: "manual",
      periodStart: run.periodStart.toISOString(),
      periodEnd: run.periodEnd.toISOString(),
    });
    return run.runId;
  });

  return { runId: runId.toString() };
}

/**
 * Give the report a new owner (module admin only). The new owner must be an
 * active employee with the BAS grant - a report cannot be handed to someone
 * who could never open it - and must not already own a report of this name.
 *
 * A report the scheduler paused because its owner was disabled is RESUMED
 * here: that pause exists so that an admin acts, and this is the act. It
 * goes back to `active` with the next run computed from now, provided it
 * still has questions and a readable schedule; otherwise to `paused`, which
 * the new owner resumes from the screen. The reason is cleared either way.
 */
export async function transferReportOwner(
  viewer: Viewer,
  reportIdText: string,
  input: TransferOwnerInput,
): Promise<OwnerTransfer> {
  const { row, admin } = await loadVisibleReport(viewer, reportIdText);
  if (!admin) throw new BasError("admin_required", "Only a module admin can transfer a report to another owner.");

  const next = await prisma.employee.findUnique({
    where: { id: input.ownerEmployeeId },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      status: true,
      grants: { where: { moduleKey: BAS_MODULE_KEY }, select: { id: true } },
    },
  });
  if (next === null || next.status !== "active" || next.grants.length === 0) {
    throw new BasError("owner_not_eligible", "The new owner has to be an active employee with access to Building Automation.");
  }
  if (next.id === row.ownerEmployeeId) {
    throw new BasError("owner_not_eligible", `${personName(next)} already owns this report.`);
  }
  await assertNameFree(next.id, row.name, row.reportId);

  const from = toState(row.state);
  let state: ReportState = from;
  let nextRunAt: Date | null = row.nextRunAt;
  let resumed = false;
  if (from === "paused_owner_disabled") {
    const spec = readScheduleSpec(row.scheduleKind, row.scheduleParams);
    const canRun = row.questions.length > 0 && spec !== null && scheduleProblem(spec) === null;
    if (canRun) {
      state = "active";
      nextRunAt = computeNextRun(spec, row.timeOfDay, row.site.timezone, new Date());
      resumed = true;
    } else {
      state = "paused";
      nextRunAt = null;
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.basReportDefinition.update({
      where: { reportId: row.reportId },
      data: { ownerEmployeeId: next.id, state, nextRunAt, pausedReason: null },
    });
    await audit(tx, "bas.report_owner_transferred", viewer, {
      reportId: row.reportId.toString(),
      name: row.name,
      fromEmployeeId: row.ownerEmployeeId,
      fromEmail: row.owner.email,
      toEmployeeId: next.id,
      toEmail: next.email,
      fromState: from,
      toState: state,
      resumed,
      nextRunAt: nextRunAt?.toISOString() ?? null,
    });
  });

  return {
    ownerEmployeeId: next.id,
    ownerName: personName(next),
    ownerEmail: next.email,
    state,
    nextRunAt: nextRunAt?.toISOString() ?? null,
    resumed,
  };
}


// ---------------------------------------------------------------------------
// The module's safety ceiling (2026-11-12)
// ---------------------------------------------------------------------------

export { readSafetyCeiling };

/**
 * Set the ceiling - either half or both - as a module admin. Upserted,
 * because the row can be absent (ceiling.ts says why), and audited with
 * both halves before and after. Not an owner's action: the ceiling applies
 * to every report in the module, which is what makes it a ceiling.
 */
export async function setSafetyCeiling(viewer: Viewer, input: SafetyCeilingInput): Promise<{ changed: boolean; ceiling: SafetyCeilingView }> {
  if (!(await canAdminister(viewer))) {
    throw new BasError("admin_required", "Only a module admin can change the safety ceiling.");
  }
  return prisma.$transaction(async (tx) => {
    const current = await readSafetyCeiling(tx);
    const next = {
      usd: input.ceilingUsd ?? current.usd,
      minutes: input.ceilingMinutes ?? current.minutes,
    };
    if (next.usd === current.usd && next.minutes === current.minutes && current.updatedAt !== null) {
      return { changed: false, ceiling: current };
    }
    await tx.basReportSettings.upsert({
      where: { settingsId: SETTINGS_ROW_ID },
      create: { settingsId: SETTINGS_ROW_ID, ceilingUsd: next.usd.toFixed(2), ceilingMinutes: next.minutes, updatedById: viewer.id },
      update: { ceilingUsd: next.usd.toFixed(2), ceilingMinutes: next.minutes, updatedById: viewer.id },
    });
    await audit(tx, "bas.report_ceiling_changed", viewer, {
      from: { usd: current.usd, minutes: current.minutes },
      to: next,
    });
    return { changed: true, ceiling: await readSafetyCeiling(tx) };
  });
}
