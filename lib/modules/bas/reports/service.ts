import { Prisma } from "@/lib/generated/prisma/client";
import { hasModuleAdmin, type Viewer } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { writeAuditEvent, type AuditAction } from "@/lib/audit";
import { BAS_MODULE_KEY } from "../constants";
import { BasError } from "../errors";
import { basSiteScope } from "../service";
import {
  describeRequiredRoles,
  parseRoleRequirements,
  sectionLabel,
  type LibraryQuestionKind,
} from "./library";
import { REPORT_PRESETS, isPresetKey, presetLabel, type PresetKey } from "./presets";
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
  type LibraryQuestionView,
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
  AddReportQuestionInput,
  CreateReportInput,
  ReportStateAction,
  UpdateReportInput,
} from "@/lib/validation/bas-reports";

/**
 * Report definitions, the shared and personal libraries, and recipients
 * (Reports, Phase 1). No runs: nothing here reads a reading.
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
 * Every write records an audit event in the same transaction, with the
 * report's name in the metadata because the row may since be renamed or gone.
 */

/** Until the Usage tab holds a module-level default (Phase 6). Dollars per run. */
export const DEFAULT_REPORT_BUDGET_USD = 2;

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
    lastRun: null,
    budgetUsd: Number(row.budgetUsd),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
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

/** The buildings the viewer may report on, each with its stations. */
export async function listReportOptions(viewer: Viewer): Promise<ReportOptions> {
  const { entitled } = await basSiteScope(viewer);
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

  return { sites: options, defaultBudgetUsd: DEFAULT_REPORT_BUDGET_USD, companyEmailDomain: COMPANY_EMAIL_DOMAIN };
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

/**
 * The library rows a preset expands to, in the preset's order. A row the
 * library lacks is a seed that did not run, and is said so.
 */
async function presetLibraryIds(tx: Tx, presetKey: PresetKey): Promise<bigint[]> {
  const keys = REPORT_PRESETS[presetKey].questionKeys;
  const rows = await tx.basLibraryQuestion.findMany({
    where: { key: { in: [...keys] } },
    select: { key: true, libraryQuestionId: true },
  });
  const byKey = new Map(rows.map((r) => [r.key, r.libraryQuestionId]));
  const missing = keys.filter((k) => !byKey.has(k));
  if (missing.length > 0) {
    throw new BasError(
      "library_question_not_found",
      `The shared library is missing ${missing.length} of the preset's questions (${missing.join(", ")}). Run the seed, then try again.`,
    );
  }
  return keys.map((k) => byKey.get(k)!);
}

/** Replace a report's questions with the preset's, in the preset's order. */
async function materialisePreset(tx: Tx, reportId: bigint, presetKey: PresetKey): Promise<number> {
  const ids = await presetLibraryIds(tx, presetKey);
  await tx.basReportQuestion.deleteMany({ where: { reportId } });
  await tx.basReportQuestion.createMany({
    data: ids.map((libraryQuestionId, position) => ({
      reportId,
      position,
      kind: "library",
      libraryQuestionId,
    })),
  });
  return ids.length;
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

  const presetKey = input.presetKey ?? null;
  const budget = input.budgetUsd ?? DEFAULT_REPORT_BUDGET_USD;

  const reportId = await prisma.$transaction(async (tx) => {
    const created = await tx.basReportDefinition.create({
      data: {
        ownerEmployeeId: viewer.id,
        name: input.name,
        description: input.description ?? null,
        siteId: site.siteId,
        stationIds,
        presetKey,
        analysisWindow: input.analysisWindow ?? "7d",
        scheduleKind: input.schedule.kind,
        scheduleParams: scheduleParamsOf(input.schedule) as Prisma.InputJsonValue,
        timeOfDay: input.timeOfDay,
        state: "draft",
        budgetUsd: new Prisma.Decimal(budget.toFixed(2)),
      },
      select: { reportId: true },
    });

    let questions = 0;
    if (presetKey !== null) {
      questions = await materialisePreset(tx, created.reportId, presetKey);
    }

    await audit(tx, "bas.report_created", viewer, {
      reportId: created.reportId.toString(),
      name: input.name,
      siteId: site.siteId.toString(),
      siteName: site.name,
      presetKey,
      questions,
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

  if (input.budgetUsd !== undefined && input.budgetUsd !== Number(row.budgetUsd)) {
    data.budgetUsd = new Prisma.Decimal(input.budgetUsd.toFixed(2));
    changes.budgetUsd = { from: Number(row.budgetUsd), to: input.budgetUsd };
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

  // The preset: set, changed, or cleared. Cleared keeps the questions as they
  // are - "variations are custom reports" - so the person varies from the
  // preset rather than from nothing.
  let presetChange: PresetKey | null | undefined;
  if (input.presetKey !== undefined && input.presetKey !== row.presetKey) {
    presetChange = input.presetKey;
    data.presetKey = input.presetKey;
    changes.presetKey = { from: row.presetKey, to: input.presetKey };
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

  if (Object.keys(changes).length === 0) {
    return { changed: false, nextRunAt: nextRunAt?.toISOString() ?? null };
  }

  await prisma.$transaction(async (tx) => {
    await tx.basReportDefinition.update({ where: { reportId: row.reportId }, data });
    if (presetChange !== undefined && presetChange !== null) {
      const count = await materialisePreset(tx, row.reportId, presetChange);
      await audit(tx, "bas.report_questions_changed", viewer, {
        reportId: row.reportId.toString(),
        name: input.name ?? row.name,
        change: "preset",
        presetKey: presetChange,
        count,
      });
    }
    await audit(tx, "bas.report_updated", viewer, {
      reportId: row.reportId.toString(),
      name: input.name ?? row.name,
      previousName: row.name,
      changes,
    });
  });

  return { changed: true, nextRunAt: nextRunAt?.toISOString() ?? null };
}

export async function deleteReport(viewer: Viewer, reportIdText: string): Promise<{ deleted: boolean }> {
  const { row } = await loadVisibleReport(viewer, reportIdText);
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
// Questions on a report
// ---------------------------------------------------------------------------

function assertNotPreset(row: DetailRow): void {
  if (row.presetKey !== null) {
    throw new BasError(
      "preset_locked",
      `This report uses the ${presetLabel(row.presetKey) ?? "preset"} and its questions are fixed. Clear the preset to vary them.`,
    );
  }
}

/** Rewrite positions 0..n-1 in the given order. */
async function renumber(tx: Tx, reportId: bigint, orderedIds: bigint[]): Promise<void> {
  for (const [position, questionId] of orderedIds.entries()) {
    await tx.basReportQuestion.update({ where: { questionId }, data: { position } });
  }
}

export async function addReportQuestion(
  viewer: Viewer,
  reportIdText: string,
  input: AddReportQuestionInput,
): Promise<{ questionId: string }> {
  const { row } = await loadVisibleReport(viewer, reportIdText);
  assertNotPreset(row);

  const position = row.questions.length;
  const questionId = await prisma.$transaction(async (tx) => {
    let created: { questionId: bigint };
    let kind: string = input.kind;

    if (input.kind === "library") {
      const id = parseId(input.libraryQuestionId);
      const lib = id === null ? null : await tx.basLibraryQuestion.findUnique({ where: { libraryQuestionId: id } });
      if (lib === null) throw new BasError("library_question_not_found", "That library question does not exist.");
      if (!lib.enabled) throw new BasError("library_question_disabled", "That library question has been turned off.");
      if (row.questions.some((q) => q.libraryQuestionId === lib.libraryQuestionId)) {
        throw new BasError("question_exists", "That question is already on this report.");
      }
      created = await tx.basReportQuestion.create({
        data: { reportId: row.reportId, position, kind: "library", libraryQuestionId: lib.libraryQuestionId },
        select: { questionId: true },
      });
    } else if (input.kind === "personal") {
      if (row.ownerEmployeeId !== viewer.id) {
        throw new BasError(
          "personal_question_not_owner",
          "Personal questions go on your own reports only. Type the question in instead.",
        );
      }
      const id = parseId(input.personalQuestionId);
      const personal =
        id === null
          ? null
          : await tx.basPersonalQuestion.findFirst({ where: { personalQuestionId: id, employeeId: viewer.id } });
      if (personal === null) throw new BasError("personal_question_not_found", "That question is not in your library.");
      if (row.questions.some((q) => q.personalQuestionId === personal.personalQuestionId)) {
        throw new BasError("question_exists", "That question is already on this report.");
      }
      created = await tx.basReportQuestion.create({
        data: { reportId: row.reportId, position, kind: "personal", personalQuestionId: personal.personalQuestionId },
        select: { questionId: true },
      });
    } else {
      if (input.saveToLibrary === true) {
        if (row.ownerEmployeeId !== viewer.id) {
          throw new BasError(
            "personal_question_not_owner",
            "A question can be saved to your library only from your own report. Add it without saving.",
          );
        }
        const personal = await tx.basPersonalQuestion.create({
          data: { employeeId: viewer.id, text: input.text },
          select: { personalQuestionId: true, text: true },
        });
        await audit(tx, "bas.personal_question_created", viewer, {
          personalQuestionId: personal.personalQuestionId.toString(),
          text: personal.text,
          fromReportId: row.reportId.toString(),
        });
        kind = "personal";
        created = await tx.basReportQuestion.create({
          data: { reportId: row.reportId, position, kind: "personal", personalQuestionId: personal.personalQuestionId },
          select: { questionId: true },
        });
      } else {
        created = await tx.basReportQuestion.create({
          data: { reportId: row.reportId, position, kind: "inline", inlineText: input.text },
          select: { questionId: true },
        });
      }
    }

    await audit(tx, "bas.report_questions_changed", viewer, {
      reportId: row.reportId.toString(),
      name: row.name,
      change: "added",
      kind,
      questionId: created.questionId.toString(),
      count: position + 1,
    });
    return created.questionId;
  });

  return { questionId: questionId.toString() };
}

export async function removeReportQuestion(
  viewer: Viewer,
  reportIdText: string,
  questionIdText: string,
): Promise<{ removed: boolean }> {
  const { row } = await loadVisibleReport(viewer, reportIdText);
  assertNotPreset(row);

  const questionId = parseId(questionIdText);
  const target = row.questions.find((q) => questionId !== null && q.questionId === questionId);
  if (target === undefined) throw new BasError("question_not_found", "That question is not on this report.");

  await prisma.$transaction(async (tx) => {
    await tx.basReportQuestion.delete({ where: { questionId: target.questionId } });
    await renumber(
      tx,
      row.reportId,
      row.questions.filter((q) => q.questionId !== target.questionId).map((q) => q.questionId),
    );
    await audit(tx, "bas.report_questions_changed", viewer, {
      reportId: row.reportId.toString(),
      name: row.name,
      change: "removed",
      kind: target.kind,
      questionId: target.questionId.toString(),
      count: row.questions.length - 1,
    });
  });
  return { removed: true };
}

export async function reorderReportQuestions(
  viewer: Viewer,
  reportIdText: string,
  questionIdTexts: string[],
): Promise<{ reordered: boolean }> {
  const { row } = await loadVisibleReport(viewer, reportIdText);
  assertNotPreset(row);

  const wanted = questionIdTexts.map((t) => parseId(t));
  const have = row.questions.map((q) => q.questionId.toString()).sort();
  const given = [...questionIdTexts].sort();
  if (wanted.some((id) => id === null) || have.join(",") !== given.join(",")) {
    throw new BasError(
      "invalid_reorder",
      "The new order has to list every question on the report exactly once.",
    );
  }

  await prisma.$transaction(async (tx) => {
    await renumber(tx, row.reportId, wanted as bigint[]);
    await audit(tx, "bas.report_questions_changed", viewer, {
      reportId: row.reportId.toString(),
      name: row.name,
      change: "reordered",
      count: row.questions.length,
    });
  });
  return { reordered: true };
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
