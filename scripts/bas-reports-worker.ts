import "./load-env";
import { readAnthropicApiKey } from "../lib/env";
import { prisma } from "../lib/db";
import { createAnthropicNarrator } from "../lib/modules/bas/reports/engine/narrative";
import { drainQueue } from "../lib/modules/bas/reports/worker";

/**
 * The report worker (Reports, Phase 3).
 *
 *   npm run bas:reports:worker                  work until the queue is empty, then exit
 *   npm run bas:reports:worker -- --once        one run at most, then exit
 *   npm run bas:reports:worker -- --no-narrative  skip the model: runs finish partial and say so
 *
 * In Azure a Container Apps Job runs this per execution (infra/main.bicep,
 * basReportsWorkerJob), started by a scaler that counts queued runs and
 * stalled ones; up to two executions at once. Each execution claims runs
 * with FOR UPDATE SKIP LOCKED, heartbeats every 30 s while the engine
 * works, and stops claiming after its drain window so an execution never
 * outlives the job's replica timeout. A run cut off mid-way is reclaimed
 * once by the next execution, after ten minutes without a heartbeat, and
 * failed with a clear error if it stalls again.
 *
 * Needs DATABASE_URL. The model is called with ANTHROPIC_API_KEY, the BAS
 * key; absent, every run finishes partial with "no model key is
 * configured", which is the honest outcome and not an error. Runs under
 * tsx, the loader tests/bas-reports-worker-render.test.ts proves the
 * template renders under.
 */

const once = process.argv.includes("--once");
const noNarrative = process.argv.includes("--no-narrative");
let stopping = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log(`[bas-reports-worker] ${signal}: the run in hand finishes, then this stops. Press again to force.`);
  });
}

async function main(): Promise<void> {
  const key = noNarrative ? null : readAnthropicApiKey();
  const narrator = key === null ? null : createAnthropicNarrator(key);
  console.log(
    `[bas-reports-worker] narrator: ${narrator === null ? (noNarrative ? "off (--no-narrative)" : "none (ANTHROPIC_API_KEY unset; runs finish partial)") : narrator.model}`,
  );
  console.log(`[bas-reports-worker] ${once ? "one run at most, then exit" : "working until the queue is empty"}`);

  const done = await drainQueue({ narrator }, once ? { maxRuns: 1 } : {});
  for (const claim of done) {
    console.log(`[bas-reports-worker] run ${claim.runId} of report ${claim.reportId}: done${claim.reclaimed ? " (reclaimed after a stall)" : ""}`);
  }
  console.log(`[bas-reports-worker] ${done.length} run(s) worked; queue ${done.length === 0 || once ? "checked" : "empty"}`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error("[bas-reports-worker]", error instanceof Error ? error.message : error);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  });
