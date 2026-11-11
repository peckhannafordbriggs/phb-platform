import type { Prisma } from "@/lib/generated/prisma/client";
import { prisma } from "@/lib/db";
import { isAnalysisWindow } from "../schedule";
import { WINDOW_MS } from "./scope";

/**
 * The queue side of a run (Reports, Phase 3): a `queued` row, and the error
 * the engine raises. Kept apart from run.ts because run.ts renders the page,
 * which imports react-dom/server, and Next refuses that in anything a route
 * or a page imports - the service queues runs and never renders one.
 */

export class ReportRunError extends Error {
  constructor(
    readonly code: "report_not_found" | "run_not_found" | "run_not_claimed" | "run_failed",
    message: string,
  ) {
    super(message);
    this.name = "ReportRunError";
  }
}

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Insert a queued run for a definition: the period is the definition's
 * window ending at `periodEnd`, the budget and zone are the definition's
 * now. The caller decides the transaction - the scheduler advances
 * `next_run_at` in the same one.
 */
export async function enqueueRun(
  db: Db,
  input: { reportId: bigint; trigger: "manual" | "scheduled"; periodEnd: Date; startedById: string | null; now?: Date },
): Promise<{ runId: bigint; periodStart: Date; periodEnd: Date }> {
  const def = await db.basReportDefinition.findUnique({
    where: { reportId: input.reportId },
    select: { analysisWindow: true, budgetUsd: true, site: { select: { timezone: true } } },
  });
  if (def === null) throw new ReportRunError("report_not_found", `No report definition ${input.reportId}.`);
  const window = isAnalysisWindow(def.analysisWindow) ? def.analysisWindow : "7d";
  const periodEnd = input.periodEnd;
  const periodStart = new Date(periodEnd.getTime() - WINDOW_MS[window]);
  const created = await db.basReportRun.create({
    data: {
      reportId: input.reportId,
      status: "queued",
      trigger: input.trigger,
      periodStart,
      periodEnd,
      timezone: def.site.timezone,
      startedById: input.startedById,
      budgetUsd: def.budgetUsd,
      ...(input.now === undefined ? {} : { createdAt: input.now }),
    },
    select: { runId: true },
  });
  return { runId: created.runId, periodStart, periodEnd };
}
