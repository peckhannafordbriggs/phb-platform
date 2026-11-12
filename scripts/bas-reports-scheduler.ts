import "./load-env";
import { prisma } from "../lib/db";
import { readSchedulerJobEnv } from "../lib/modules/bas/reports/job-env";
import { runSchedulerPass } from "../lib/modules/bas/reports/scheduler";

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
 * account is disabled are paused with the reason recorded. Needs
 * DATABASE_URL and nothing else; prints what it did and exits 0, or exits
 * 1 if the pass threw, which Container Apps shows as a failed execution.
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
  console.log(`[bas-reports-scheduler] ${pass.enqueued.length} queued, ${pass.paused.length} paused, ${pass.skipped.length} skipped`);
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
