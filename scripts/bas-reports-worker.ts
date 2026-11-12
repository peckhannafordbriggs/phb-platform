import "./load-env";
import { prisma } from "../lib/db";
import { createAnthropicNarrator } from "../lib/modules/bas/reports/engine/narrative";
import { ANTHROPIC_API_KEY_VAR, readWorkerJobEnv } from "../lib/modules/bas/reports/job-env";
import { createChromiumRenderer } from "../lib/modules/bas/reports/pdf/render";
import { drainQueue } from "../lib/modules/bas/reports/worker";

/**
 * The report worker (Reports, Phase 3; the PDF since Phase 4).
 *
 *   npm run bas:reports:worker                  work until the queue is empty, then exit
 *   npm run bas:reports:worker -- --once        one run at most, then exit
 *   npm run bas:reports:worker -- --no-narrative  skip the model: runs finish partial and say so
 *   npm run bas:reports:worker -- --no-pdf      skip Chromium: PDFs stay queued for a worker that has it
 *
 * In Azure a Container Apps Job runs this per execution (infra/main.bicep,
 * basReportsWorkerJob), started by a scaler that counts queued runs,
 * stalled ones and queued PDF renders; up to two executions at once. Each
 * execution claims runs with FOR UPDATE SKIP LOCKED, heartbeats every 30 s
 * while the engine works, prints each finished run's page to PDF with
 * headless Chromium (lib/modules/bas/reports/pdf/render.ts; the image
 * carries the browser, Dockerfile.bas-reports), and stops claiming after
 * its drain window so an execution never outlives the job's replica
 * timeout. A run cut off mid-way is reclaimed once by the next execution,
 * after ten minutes without a heartbeat, and failed with a clear error if
 * it stalls again. A PDF that fails never fails its run: the failure is
 * on the run's PDF columns, with Retry PDF on the screens.
 *
 * Needs DATABASE_URL. The model is called with ANTHROPIC_API_KEY, the BAS
 * key; absent, every run finishes partial with "no model key is
 * configured", which is the honest outcome and not an error. Runs under
 * tsx, the loader tests/bas-reports-worker-render.test.ts proves the
 * template renders under.
 *
 * Both are read through lib/modules/bas/reports/job-env.ts and NEVER
 * through lib/env.ts: that module parses the web app's whole boot schema
 * on import, and importing one name from it failed this job on every
 * production execution (ALLOWED_EMAIL_DOMAINS, a variable the job does
 * not carry; 2026-11-11). tests/bas-reports-jobs-env.test.ts boots this
 * script with only the template's variables and walks its import graph.
 */

const once = process.argv.includes("--once");
const noNarrative = process.argv.includes("--no-narrative");
const noPdf = process.argv.includes("--no-pdf");
let stopping = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log(`[bas-reports-worker] ${signal}: the run in hand finishes, then this stops. Press again to force.`);
  });
}

async function main(): Promise<void> {
  const jobEnv = readWorkerJobEnv();
  const key = noNarrative ? null : jobEnv.anthropicApiKey;
  const narrator = key === null ? null : createAnthropicNarrator(key);
  const pdf = noPdf ? null : createChromiumRenderer();
  console.log(
    `[bas-reports-worker] narrator: ${narrator === null ? (noNarrative ? "off (--no-narrative)" : `none (${ANTHROPIC_API_KEY_VAR} unset; runs finish partial)`) : narrator.model}`,
  );
  console.log(`[bas-reports-worker] pdf: ${pdf === null ? "off (--no-pdf; renders stay queued)" : "Chromium, launched on the first render"}`);
  console.log(`[bas-reports-worker] ${once ? "one run at most, then exit" : "working until the queue is empty"}`);

  try {
    const done = await drainQueue({ narrator, pdf }, once ? { maxRuns: 1 } : {});
    for (const claim of done.runs) {
      console.log(`[bas-reports-worker] run ${claim.runId} of report ${claim.reportId}: done${claim.reclaimed ? " (reclaimed after a stall)" : ""}`);
    }
    for (const outcome of done.pdfs) {
      console.log(
        outcome.ok
          ? `[bas-reports-worker] pdf of run ${outcome.runId} (${outcome.name}): ${outcome.bytes} bytes`
          : `[bas-reports-worker] pdf of run ${outcome.runId} (${outcome.name}): FAILED - ${outcome.error}`,
      );
    }
    console.log(
      `[bas-reports-worker] ${done.runs.length} run(s) worked, ${done.pdfs.length} pdf(s) rendered; queue ${done.runs.length === 0 || once ? "checked" : "empty"}`,
    );
  } finally {
    if (pdf !== null) await pdf.close();
  }
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
