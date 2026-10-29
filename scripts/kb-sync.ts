import "./load-env";

/**
 * Sync the Knowledge Base index with its library, once, and print what changed.
 *
 *   npm run kb:sync                      the configured source
 *   npm run kb:sync -- --dir "<folder>"  a local folder instead (not in production)
 *   npm run kb:sync -- --no-index        list and queue only; read no files
 *
 * The source is KB_SHAREPOINT_LIBRARY_URL (SharePoint, the KB app registration)
 * or else KB_LOCAL_SOURCE_DIR (a synced copy). Writes kb_projects,
 * kb_documents, kb_chunks and one kb_sync_runs row in DATABASE_URL. New and
 * changed files are read into passages; unchanged ones are not read again.
 * The first run over a whole library takes a while (about 5 s per 300-page
 * PDF); a second run with nothing new takes seconds.
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
      index: !process.argv.includes("--no-index"),
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
