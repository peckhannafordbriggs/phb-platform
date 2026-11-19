import { prisma } from "@/lib/db";
import { readKbEmbeddingEnv } from "./env";

/**
 * What the Knowledge Base admin screen shows: the recent syncs, how many
 * documents are in each state, and the files that could not be read. Read
 * only; the Index button writes through queueKbSync (sync.ts).
 */

export const KB_ADMIN_RECENT_SYNCS = 10;
export const KB_ADMIN_FAILED_LIMIT = 50;

export async function getKbIndexStatus() {
  const [syncs, byStatus, chunks, embedded, failed] = await Promise.all([
    prisma.kbSyncRun.findMany({
      orderBy: { startedAt: "desc" },
      take: KB_ADMIN_RECENT_SYNCS,
      include: { triggeredBy: { select: { firstName: true, lastName: true } } },
    }),
    prisma.kbDocument.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.kbChunk.count(),
    prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM kb_chunks WHERE embedding IS NOT NULL`,
    prisma.kbDocument.findMany({
      where: { status: "failed" },
      orderBy: [{ project: { folderName: "asc" } }, { path: "asc" }],
      take: KB_ADMIN_FAILED_LIMIT,
      select: { id: true, path: true, error: true, project: { select: { folderName: true } } },
    }),
  ]);

  const documents = { pending: 0, indexed: 0, skipped: 0, failed: 0 };
  for (const row of byStatus) documents[row.status] = row._count._all;

  return {
    syncs: syncs.map((s) => ({
      id: s.id,
      status: s.status,
      trigger: s.trigger,
      sourceKind: s.sourceKind,
      triggeredBy: s.triggeredBy ? `${s.triggeredBy.firstName} ${s.triggeredBy.lastName}` : null,
      startedAt: s.startedAt.toISOString(),
      finishedAt: s.finishedAt?.toISOString() ?? null,
      heartbeatAt: s.heartbeatAt?.toISOString() ?? null,
      projectsSeen: s.projectsSeen,
      filesSeen: s.filesSeen,
      filesIndexed: s.filesIndexed,
      filesUnchanged: s.filesUnchanged,
      filesSkipped: s.filesSkipped,
      filesFailed: s.filesFailed,
      filesRemoved: s.filesRemoved,
      chunksWritten: s.chunksWritten,
      chunksEmbedded: s.chunksEmbedded,
      embeddingTokens: s.embeddingTokens,
      error: s.error,
    })),
    documents,
    chunks: { total: chunks, embedded: embedded[0]?.n ?? 0 },
    /** Whether this process could embed: the variables are present (not that Azure accepts them). */
    embeddingConfigured: safeEmbeddingConfigured(),
    failed: failed.map((d) => ({ id: d.id, path: `${d.project.folderName}/${d.path}`, error: d.error ?? "" })),
  };
}

export type KbIndexStatus = Awaited<ReturnType<typeof getKbIndexStatus>>;
export type KbSyncSummary = KbIndexStatus["syncs"][number];

function safeEmbeddingConfigured(): boolean {
  try {
    return readKbEmbeddingEnv().present;
  } catch {
    return false; // a key in production: misconfigured, so not usable
  }
}
