import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prisma } from "@/lib/db";
import { logUnexpected } from "@/lib/logger";
import { KNOWLEDGE_BASE_MODULE_KEY } from "./constants";
import { extractDocument } from "./extract";
import type { KbSource } from "./source";

/**
 * Turns `pending` documents into `indexed` ones: fetch the file from the
 * source, read it into passages (extract.ts, chunk.ts), and write them as
 * kb_chunks. Runs inside the sync, after the listing, so one pipeline both
 * notices a change and indexes it.
 *
 * Embeddings are not written here: chunks start with a NULL embedding, which
 * the schema allows so that embedding can run (and resume) separately once
 * Azure OpenAI is available. Keyword search works on them from the start,
 * through content_tsv.
 *
 * One file at a time: extraction is CPU-bound, and a 1,000-page spec held
 * twice would only add memory. The file is copied to a private temp folder,
 * read, and deleted. Each document is its own transaction; a file that cannot
 * be read becomes `failed` with the reason, and the next sync retries it.
 */

/** A file that has not finished reading in this long is abandoned and marked failed. */
export const KB_EXTRACT_TIMEOUT_MS = 5 * 60 * 1000;

export type KbIndexCounts = {
  filesIndexed: number;
  filesFailed: number;
  /** Read cleanly, no text (a scan with no text layer): skipped as `empty_text`. */
  filesEmpty: number;
  chunksWritten: number;
};

export async function indexPending(options: {
  source: KbSource;
  /** Called after each document; the sync stamps its heartbeat here. */
  onProgress?: (counts: KbIndexCounts) => Promise<void>;
  /** Stop after this many documents (tests). */
  limit?: number;
  now?: () => Date;
}): Promise<KbIndexCounts> {
  const now = options.now ?? (() => new Date());
  const counts: KbIndexCounts = { filesIndexed: 0, filesFailed: 0, filesEmpty: 0, chunksWritten: 0 };
  const workDir = await mkdtemp(path.join(tmpdir(), "kb-index-"));
  const done = new Set<string>();

  try {
    for (;;) {
      if (options.limit !== undefined && done.size >= options.limit) break;
      // Current versions first, so a partial run indexes what answers lead with.
      const batch = await prisma.kbDocument.findMany({
        where: { status: "pending", sourceKind: options.source.kind, id: { notIn: [...done] } },
        orderBy: [{ isLatest: "desc" }, { path: "asc" }],
        take: 25,
        select: { id: true, path: true, fileType: true, etag: true, project: { select: { folderName: true } } },
      });
      if (batch.length === 0) break;

      for (const doc of batch) {
        if (options.limit !== undefined && done.size >= options.limit) break;
        done.add(doc.id);
        const local = path.join(workDir, `${doc.id}.${doc.fileType || "bin"}`);
        try {
          await options.source.store.downloadFile(`${doc.project.folderName}/${doc.path}`, local);
          const extraction = await withTimeout(extractDocument(local, doc.fileType), KB_EXTRACT_TIMEOUT_MS);

          if (extraction.empty) {
            await prisma.kbDocument.updateMany({
              where: { id: doc.id, status: "pending", etag: doc.etag },
              data: { status: "skipped", skipReason: "empty_text", chunkCount: 0 },
            });
            counts.filesEmpty += 1;
          } else {
            const { chunks } = extraction;
            const wrote = await prisma.$transaction(
              async (tx) => {
                // Still the version that was read: a sync in between would have changed the tag.
                const claimed = await tx.kbDocument.updateMany({
                  where: { id: doc.id, status: "pending", etag: doc.etag },
                  data: { status: "indexed", chunkCount: chunks.length, indexedAt: now(), error: null },
                });
                if (claimed.count === 0) return false;
                await tx.kbChunk.deleteMany({ where: { documentId: doc.id } });
                await tx.kbChunk.createMany({
                  data: chunks.map((c, ordinal) => ({ documentId: doc.id, ordinal, ...c })),
                });
                return true;
              },
              { timeout: 60_000 },
            );
            if (wrote) {
              counts.filesIndexed += 1;
              counts.chunksWritten += chunks.length;
            }
          }
        } catch (error) {
          await prisma.kbDocument.updateMany({
            where: { id: doc.id, status: "pending" },
            data: { status: "failed", error: describe(error), chunkCount: 0 },
          });
          counts.filesFailed += 1;
          logUnexpected("kb.index_document_failed", error, { moduleKey: KNOWLEDGE_BASE_MODULE_KEY });
        } finally {
          await rm(local, { force: true });
        }
        await options.onProgress?.(counts);
      }
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
  return counts;
}

/** What `kb_documents.error` says: short, and in words a person can act on. */
function describe(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  const text =
    name === "PasswordException"
      ? "The PDF is password-protected."
      : name === "InvalidPDFException"
        ? `Not a readable PDF: ${message}`
        : message;
  return text.length > 1000 ? `${text.slice(0, 1000)}...` : text || "Unknown error.";
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Reading the file took longer than ${ms / 60000} minutes.`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
