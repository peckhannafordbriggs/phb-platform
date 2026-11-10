import { hasModuleAdmin, type Viewer } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { BAS_MODULE_KEY } from "../constants";
import { BasError } from "../errors";
import { basSiteScope } from "../service";
import type { ReportDocument, RunStatus } from "./engine/types";

/**
 * Reading runs (Reports, Phase 2). The same visibility as a definition: its
 * owner, or a module admin; anyone else is told the run does not exist.
 * Nothing here writes - a run is written by the engine and, from Phase 3,
 * the worker.
 */

export interface RunSummary {
  runId: string;
  reportId: string;
  reportName: string;
  buildingName: string;
  status: RunStatus;
  trigger: string;
  periodStart: string;
  periodEnd: string;
  timezone: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationS: number | null;
  costUsd: number;
  budgetUsd: number;
  inputTokens: number;
  outputTokens: number;
  partialReason: string | null;
  error: string | null;
  /** Findings new or still open; cleared rows are not counted. */
  findings: number;
  buildingStatus: string | null;
  startedBy: string | null;
}

export interface RunDetail extends RunSummary {
  document: ReportDocument | null;
  previousRunId: string | null;
}

export interface RunsList {
  runs: RunSummary[];
  runsInDatabase: number;
}

function toStatus(value: string): RunStatus {
  return value === "queued" || value === "running" || value === "succeeded" || value === "partial" || value === "failed" ? value : "failed";
}

const RUN_INCLUDE = {
  report: { select: { name: true, ownerEmployeeId: true, siteId: true, site: { select: { name: true } } } },
  startedBy: { select: { email: true } },
  _count: { select: { findings: { where: { state: { not: "cleared" } } } } },
} as const;

type RunRow = Awaited<ReturnType<typeof prisma.basReportRun.findFirstOrThrow<{ include: typeof RUN_INCLUDE }>>>;

function toSummary(r: RunRow): RunSummary {
  const doc = r.reportJson as unknown as ReportDocument | null;
  return {
    runId: r.runId.toString(),
    reportId: r.reportId.toString(),
    reportName: r.report.name,
    buildingName: r.report.site.name,
    status: toStatus(r.status),
    trigger: r.trigger,
    periodStart: r.periodStart.toISOString(),
    periodEnd: r.periodEnd.toISOString(),
    timezone: r.timezone,
    startedAt: r.startedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
    durationS:
      r.startedAt !== null && r.finishedAt !== null ? Math.round((r.finishedAt.getTime() - r.startedAt.getTime()) / 1000) : null,
    costUsd: Number(r.costUsd),
    budgetUsd: Number(r.budgetUsd),
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    partialReason: r.partialReason,
    error: r.error,
    findings: r._count.findings,
    buildingStatus: doc?.summary?.status ?? null,
    startedBy: r.startedBy?.email ?? null,
  };
}

async function visibilityWhere(viewer: Viewer) {
  const admin = await hasModuleAdmin(viewer.id, BAS_MODULE_KEY);
  const { entitled } = await basSiteScope(viewer);
  return {
    report: {
      ...(admin ? {} : { ownerEmployeeId: viewer.id }),
      ...(entitled === null ? {} : { siteId: { in: entitled } }),
    },
  };
}

export async function listRuns(viewer: Viewer, reportIdText: string | null): Promise<RunsList> {
  const visible = await visibilityWhere(viewer);
  const reportId = reportIdText !== null && /^[0-9]{1,20}$/.test(reportIdText) ? BigInt(reportIdText) : null;
  const where = { ...visible, ...(reportId === null ? {} : { reportId }) };
  const [rows, runsInDatabase] = await Promise.all([
    prisma.basReportRun.findMany({
      where,
      include: RUN_INCLUDE,
      orderBy: [{ createdAt: "desc" }, { runId: "desc" }],
      take: 200,
    }),
    prisma.basReportRun.count({ where }),
  ]);
  return { runs: rows.map(toSummary), runsInDatabase };
}

export async function getRun(viewer: Viewer, runIdText: string): Promise<RunDetail> {
  const notFound = () => new BasError("run_not_found", "That run does not exist, or you do not have access to it.");
  if (!/^[0-9]{1,20}$/.test(runIdText)) throw notFound();
  const visible = await visibilityWhere(viewer);
  const row = await prisma.basReportRun.findFirst({ where: { runId: BigInt(runIdText), ...visible }, include: RUN_INCLUDE });
  if (row === null) throw notFound();
  return {
    ...toSummary(row),
    document: (row.reportJson as unknown as ReportDocument | null) ?? null,
    previousRunId: row.previousRunId?.toString() ?? null,
  };
}
