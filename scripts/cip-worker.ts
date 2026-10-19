import "./load-env";

/**
 * The Cost Intelligence run worker.
 *
 *   npm run cip:worker            keep polling for queued runs (local)
 *   npm run cip:worker -- --once  work on at most one run, then exit (a Container Apps Job execution)
 *
 * Needs DATABASE_URL, ANTHROPIC_API_KEY and CIP_PROJECTS_DIR (where outputs go). Projects
 * and skills come from SharePoint when CIP_SHAREPOINT_* is set, else the local folders.
 * In Docker (docker-compose.cip-worker.yml sets CIP_IN_DOCKER), a localhost
 * database is reached as host.docker.internal.
 * Stops cleanly on Ctrl+C / SIGTERM once the run in hand reaches a stopping
 * point; a run cut off mid-way is failed by the next worker after 10 minutes.
 */

const POLL_MS = 5_000;
const once = process.argv.includes("--once");
let stopping = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log(`[cip-worker] ${signal}: finishing the current run, then stopping. Press again to force.`);
  });
}

/** Inside a container, localhost is the container; the database is on the host. */
function reachHostDatabase() {
  const url = process.env.DATABASE_URL;
  if (process.env.CIP_IN_DOCKER !== "1" || !url) return;
  process.env.DATABASE_URL = url.replace(/@(localhost|127\.0\.0\.1)([:/])/, "@host.docker.internal$2");
}

async function main() {
  reachHostDatabase();
  // Imported after the line above: the database client reads DATABASE_URL when it loads.
  const { workOnce, workerConfigFromEnv } = await import("../lib/modules/cost-intelligence/worker");
  const config = workerConfigFromEnv();
  console.log(`[cip-worker] projects: ${config.sources?.projects} (read-only)`);
  console.log(`[cip-worker] skills:   ${config.sources?.skills} (read-only)`);
  console.log(`[cip-worker] outputs:  ${config.outputsDir}/<project>/AI FILES`);
  console.log(`[cip-worker] ${once ? "one run, then exit" : `polling every ${POLL_MS / 1000}s`}`);

  while (!stopping) {
    const runId = await workOnce(config);
    if (runId !== null) console.log(`[cip-worker] run ${runId}: stopped working on it (finished, waiting or cancelled)`);
    if (once) break;
    if (runId === null) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error("[cip-worker]", error instanceof Error ? error.message : error);
    process.exit(1);
  });
