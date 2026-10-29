import "./load-env";

/**
 * Sync the Knowledge Base index with its library, once, and print what changed.
 *
 *   npm run kb:sync                      the configured source
 *   npm run kb:sync -- --dir "<folder>"  a local folder instead (not in production)
 *
 * The source is KB_SHAREPOINT_LIBRARY_URL (SharePoint, the KB app registration)
 * or else KB_LOCAL_SOURCE_DIR (a synced copy). Writes kb_projects,
 * kb_documents and one kb_sync_runs row in DATABASE_URL. Reads no file
 * contents: new and changed files are queued (`pending`) for the indexer.
 * runbook.md -> Knowledge Base.
 */

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function main() {
  const { syncKnowledgeBase } = await import("../lib/modules/knowledge-base/sync");
  const { localKbSource } = await import("../lib/modules/knowledge-base/source");
  const { prisma } = await import("../lib/db");

  const dir = argValue("--dir");
  if (dir !== null && process.env.NODE_ENV === "production") {
    throw new Error("--dir is not used in production; production syncs the SharePoint library.");
  }

  try {
    const outcome = await syncKnowledgeBase({
      trigger: "manual",
      triggeredById: null,
      ...(dir !== null ? { source: localKbSource(dir) } : {}),
    });
    console.log(JSON.stringify(outcome, null, 2));
    if (outcome.status === "failed") process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
