import { prisma } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { BAS_MODULE_KEY } from "../constants";
import { enqueueRun } from "./engine/queue";
import { computeNextRun, readScheduleSpec, scheduleProblem, type ScheduleSpec } from "./schedule";

/**
 * The report scheduler (Reports, Phase 3): one pass, run every fifteen
 * minutes by a Container Apps cron job (infra/main.bicep,
 * basReportsSchedulerJob) through scripts/bas-reports-scheduler.ts.
 *
 * For every active definition whose `next_run_at` has passed it queues ONE
 * run and advances `next_run_at`, in one transaction on a locked row, so
 * two passes cannot queue the same occurrence and a crash between the two
 * writes cannot leave a run without an advance. A definition that missed
 * several ticks - the job was off, the platform was down - gets one run,
 * for the latest occurrence that has passed, never a backfill: a weekly
 * report that was off for a month is one report for the last week, not
 * four for weeks nobody will read.
 *
 * Before any of that, every active definition whose owner's account is
 * disabled is paused as `paused_owner_disabled` with the reason on the row
 * and an audit event. A report nobody can receive should not run, and the
 * state says who has to act: a module admin, by transferring the owner
 * (service.ts, transferReportOwner), which resumes it.
 *
 * The schedule arithmetic is Phase 1's `computeNextRun`, untouched - the
 * DST cases are tests/bas-reports-schedule.test.ts's and are not repeated.
 */

export interface SchedulerPass {
  at: string;
  enqueued: Array<{ reportId: string; name: string; runId: string; periodEnd: string; nextRunAt: string; missedTicks: number }>;
  paused: Array<{ reportId: string; name: string; ownerEmail: string }>;
  skipped: Array<{ reportId: string; name: string; reason: string }>;
}

/**
 * Collapse the ticks a definition missed into one. From the occurrence that
 * was due, walk forward through the occurrences that have also passed; the
 * last of them is the one run's period end, and the first that has not
 * passed is the new `next_run_at`. A due instant that is not itself an
 * occurrence (a hand-edited next_run_at) is taken as given and the walk
 * starts from it.
 */
export function collapseMissedTicks(
  spec: ScheduleSpec,
  timeOfDay: string,
  timezone: string,
  due: Date,
  now: Date,
): { periodEnd: Date; nextRunAt: Date; missedTicks: number } {
  let occurrence = due;
  let missedTicks = 0;
  for (let i = 0; i < 100_000; i += 1) {
    const next = computeNextRun(spec, timeOfDay, timezone, occurrence);
    if (next.getTime() > now.getTime()) return { periodEnd: occurrence, nextRunAt: next, missedTicks };
    occurrence = next;
    missedTicks += 1;
  }
  throw new Error("The schedule's occurrences never reached the present.");
}

export async function runSchedulerPass(now = new Date()): Promise<SchedulerPass> {
  const pass: SchedulerPass = { at: now.toISOString(), enqueued: [], paused: [], skipped: [] };

  const active = await prisma.basReportDefinition.findMany({
    where: { state: "active" },
    select: {
      reportId: true,
      name: true,
      nextRunAt: true,
      scheduleKind: true,
      scheduleParams: true,
      timeOfDay: true,
      site: { select: { timezone: true } },
      owner: { select: { id: true, email: true, status: true } },
    },
    orderBy: { reportId: "asc" },
  });

  for (const def of active) {
    if (def.owner.status !== "active") {
      const reason = `Paused on ${now.toISOString().slice(0, 10)}: the owner's account (${def.owner.email}) is disabled. A module admin can transfer the report to another owner, which resumes it.`;
      await prisma.$transaction(async (tx) => {
        const updated = await tx.basReportDefinition.updateMany({
          where: { reportId: def.reportId, state: "active" },
          data: { state: "paused_owner_disabled", nextRunAt: null, pausedReason: reason },
        });
        if (updated.count === 0) return;
        pass.paused.push({ reportId: def.reportId.toString(), name: def.name, ownerEmail: def.owner.email });
        await writeAuditEvent(tx, {
          action: "bas.report_state_changed",
          actorEmployeeId: null,
          moduleKey: BAS_MODULE_KEY,
          metadata: {
            reportId: def.reportId.toString(),
            name: def.name,
            from: "active",
            to: "paused_owner_disabled",
            nextRunAt: null,
            reason,
            ownerEmail: def.owner.email,
          },
        });
      });
      continue;
    }

    if (def.nextRunAt === null || def.nextRunAt.getTime() > now.getTime()) continue;

    await prisma.$transaction(async (tx) => {
      // The row, locked: a second pass in the same instant waits here and
      // then sees the advanced next_run_at.
      const locked = await tx.$queryRaw<{ state: string; next_run_at: Date | null }[]>`
        SELECT state, next_run_at FROM bas_report_definitions WHERE report_id = ${def.reportId} FOR UPDATE`;
      const row = locked[0];
      if (row === undefined || row.state !== "active" || row.next_run_at === null || row.next_run_at.getTime() > now.getTime()) {
        pass.skipped.push({ reportId: def.reportId.toString(), name: def.name, reason: "already advanced by another pass" });
        return;
      }
      const spec = readScheduleSpec(def.scheduleKind, def.scheduleParams);
      if (spec === null || scheduleProblem(spec) !== null) {
        pass.skipped.push({ reportId: def.reportId.toString(), name: def.name, reason: "the stored schedule could not be read" });
        logger.error("bas.report_schedule_unreadable", {
          outcome: "skipped",
          reason: `report ${def.reportId} (${def.name}) is active with an unreadable schedule; nothing queued`,
        });
        return;
      }
      const { periodEnd, nextRunAt, missedTicks } = collapseMissedTicks(spec, def.timeOfDay, def.site.timezone, row.next_run_at, now);
      const run = await enqueueRun(tx, { reportId: def.reportId, trigger: "scheduled", periodEnd, startedById: null, now });
      await tx.basReportDefinition.update({ where: { reportId: def.reportId }, data: { nextRunAt } });
      await writeAuditEvent(tx, {
        action: "bas.report_run_requested",
        actorEmployeeId: null,
        moduleKey: BAS_MODULE_KEY,
        metadata: {
          reportId: def.reportId.toString(),
          runId: run.runId.toString(),
          name: def.name,
          trigger: "scheduled",
          periodStart: run.periodStart.toISOString(),
          periodEnd: run.periodEnd.toISOString(),
          nextRunAt: nextRunAt.toISOString(),
          missedTicks,
        },
      });
      pass.enqueued.push({
        reportId: def.reportId.toString(),
        name: def.name,
        runId: run.runId.toString(),
        periodEnd: periodEnd.toISOString(),
        nextRunAt: nextRunAt.toISOString(),
        missedTicks,
      });
    });
  }

  logger.info("bas.report_scheduler_pass", {
    outcome: "ok",
    reason: `${pass.enqueued.length} queued, ${pass.paused.length} paused, ${pass.skipped.length} skipped`,
  });
  return pass;
}
