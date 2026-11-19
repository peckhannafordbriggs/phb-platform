import "./load-env";

/**
 * The Knowledge Base worker: runs the syncs the admin's Index button queues.
 *
 *   npm run kb:worker            keep polling for queued syncs (local)
 *   npm run kb:worker -- --once  run at most one queued sync, then exit
 *                                (a Container Apps Job execution)
 *
 * Needs DATABASE_URL and the KB source (KB_SHAREPOINT_LIBRARY_URL with the
 * PHB_PLATFORM_KB_APP_* identity, or KB_LOCAL_SOURCE_DIR locally). In Azure
 * the job (infra/main.bicep, kbWorkerJob) is started by its scaler when a
 * `queued` kb_sync_runs row appears, and runs this with --once.
 *
 * Ctrl+C / SIGTERM stops after the sync in hand; one cut off mid-way stops
 * sending heartbeats and is closed by the next sync after ten minutes, and
 * the files it had not reached stay `pending` for the next one.
 */

const POLL_MS = 5_000;
const once = process.argv.includes("--once");
let stopping = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log(`[kb-worker] ${signal}: finishing the current sync, then stopping. Press again to force.`);
  });
}

async function main() {
  const { claimQueuedKbSync, syncKnowledgeBase } = await import("../lib/modules/knowledge-base/sync");
  const { prisma } = await import("../lib/db");

  try {
    while (!stopping) {
      const claimed = await claimQueuedKbSync(new Date());
      if (claimed) {
        console.log(`[kb-worker] sync ${claimed.id} (${claimed.trigger}) started`);
        const outcome = await syncKnowledgeBase({
          trigger: claimed.trigger,
          triggeredById: claimed.triggeredById,
          claimedId: claimed.id,
        });
        console.log(`[kb-worker] sync ${claimed.id} ${outcome.status}`, JSON.stringify(outcome));
        if (outcome.status === "failed") process.exitCode = 1;
      } else if (once) {
        console.log("[kb-worker] nothing queued");
      }
      if (once) break;
      if (!claimed) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error("[kb-worker]", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
