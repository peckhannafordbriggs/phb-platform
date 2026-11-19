import "./load-env";
import { prisma } from "../lib/db";
import { readSchedulerJobEnv } from "../lib/modules/bas/reports/job-env";
import { abandonedCount, runSchedulerPass } from "../lib/modules/bas/reports/scheduler";
import { runAutoAssignPass } from "../lib/modules/bas/auto-assign";

/**
 * The report scheduler, one pass (Reports, Phase 3).
 *
 *   npm run bas:reports:scheduler
 *
 * In Azure a Container Apps Job runs this on a cron every fifteen minutes
 * (infra/main.bicep, basReportsSchedulerJob). For every active report whose
 * next run time has passed it queues ONE run and advances the next run time
 * in the same transaction; a report that missed several ticks gets one run,
 * for the latest occurrence, never a backfill. Active reports whose owner's
 * account is disabled are paused with the reason recorded. Before any of
 * that it fails abandoned work (2026-11-13): a run queued for an hour that
 * no worker claimed, a run lost twice, a PDF render queued for an hour -
 * so a worker that cannot start does not keep the scaler restarting it.
 * Needs DATABASE_URL and nothing else; prints what it did and exits 0, or
 * exits 1 if the pass threw, which Container Apps shows as a failed
 * execution.
 *
 * THE ASSIGNMENT STEP (2026-11-19). After the reports, the same execution
 * runs the automatic point assignment over every station
 * (lib/modules/bas/auto-assign.ts): high-confidence roles and equipment for
 * collected points nobody has classified, never a point a person set, never
 * a half that has a value. A station with nothing new costs one aggregate
 * query; one that fails is printed and the others still run, and then the
 * execution exits 1 so it reads Failed - the reports above it are already
 * committed. runbook.md -> "A point was given a role or equipment nobody
 * chose".
 *
 * Read through lib/modules/bas/reports/job-env.ts and never lib/env.ts,
 * which is the web app's boot schema and fails a job that imports it
 * (the worker did, 2026-11-11). tests/bas-reports-jobs-env.test.ts boots
 * this script with only the template's variables.
 */
async function main(): Promise<void> {
  readSchedulerJobEnv();
  const pass = await runSchedulerPass();
  console.log(`[bas-reports-scheduler] pass at ${pass.at}`);
  for (const r of pass.enqueued) {
    console.log(
      `[bas-reports-scheduler] queued run ${r.runId} of report ${r.reportId} (${r.name}) for the period ending ${r.periodEnd}; next run ${r.nextRunAt}${r.missedTicks > 0 ? `; ${r.missedTicks} missed tick(s) collapsed` : ""}`,
    );
  }
  for (const p of pass.paused) {
    console.log(`[bas-reports-scheduler] paused report ${p.reportId} (${p.name}): owner ${p.ownerEmail} is disabled`);
  }
  for (const s of pass.skipped) {
    console.log(`[bas-reports-scheduler] skipped report ${s.reportId} (${s.name}): ${s.reason}`);
  }
  for (const r of pass.abandoned.unclaimedRuns) {
    console.log(`[bas-reports-scheduler] failed run ${r.runId} of report ${r.reportId} (${r.name}): never claimed - ${r.error}`);
  }
  for (const r of pass.abandoned.stalledRuns) {
    console.log(`[bas-reports-scheduler] failed run ${r.runId} of report ${r.reportId} (${r.name}): stalled twice`);
  }
  for (const r of pass.abandoned.unclaimedPdfs) {
    console.log(`[bas-reports-scheduler] failed the PDF of run ${r.runId} (${r.name}): never claimed - ${r.error}`);
  }
  for (const d of pass.abandoned.abandonedDeliveries) {
    console.log(`[bas-reports-scheduler] failed delivery ${d.deliveryId} of run ${d.runId}: ${d.error}`);
  }
  console.log(
    `[bas-reports-scheduler] ${pass.enqueued.length} queued, ${pass.paused.length} paused, ${pass.skipped.length} skipped, ${abandonedCount(pass.abandoned)} abandoned`,
  );

  const assignment = await runAutoAssignPass();
  for (const s of assignment.stations) {
    if (s.outcome !== "assigned") continue;
    console.log(
      `[bas-reports-scheduler] assigned station ${s.stationId} (${s.stationName}): a role on ${s.roleAssigned}, equipment on ${s.equipmentAttached}, ${s.equipmentCreated.length} piece(s) of equipment created; ${s.needDecision} need a decision`,
    );
  }
  for (const f of assignment.failed) {
    console.error(`[bas-reports-scheduler] assignment failed on station ${f.stationId} (${f.stationName}): ${f.error}`);
  }
  const assigned = assignment.stations.filter((s) => s.outcome === "assigned").length;
  console.log(
    `[bas-reports-scheduler] assignment: ${assignment.stations.length} station(s), ${assigned} assigned, ${assignment.failed.length} failed`,
  );
  if (assignment.failed.length > 0) {
    throw new Error(`the point assignment failed on ${assignment.failed.length} station(s); see the lines above`);
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error("[bas-reports-scheduler]", error instanceof Error ? error.message : error);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  });
