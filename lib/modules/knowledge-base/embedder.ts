import { prisma } from "@/lib/db";
import { KB_EMBEDDING_MODEL, embeddingInput, type KbEmbedder } from "./embed";
import { toVectorLiteral } from "./vector";

/**
 * Fills in kb_chunks.embedding for every indexed passage that has none: the
 * last step of a sync, after the indexer. Works from the database, not from
 * the sync's own list, so it also covers everything indexed before
 * embeddings were configured, and a sync that stopped half way is finished
 * by the next one.
 *
 * Batches of KB_EMBED_BATCH passages per request. Current versions first, so
 * a run cut short has embedded what answers lead with. A vector is written
 * only where the passage still has none, so a re-index between the read and
 * the write loses nothing and duplicates nothing.
 *
 * Any refusal from the service stops this step (not the sync): the passages
 * left keep a NULL embedding and keyword search still finds them, and the
 * next sync carries on where this one stopped.
 */

/**
 * Passages per request. Well inside Azure's limits (2,048 inputs and 300,000
 * tokens per request): a passage is at most 2,400 characters, about 600
 * tokens, so a batch is at most ~40,000.
 */
export const KB_EMBED_BATCH = 64;

export type KbEmbedCounts = {
  chunksEmbedded: number;
  /** As Azure counted them: what the deployment's quota and bill see. */
  embeddingTokens: number;
};

type Pending = {
  id: string;
  document_id: string;
  content: string;
  page_start: number | null;
  page_end: number | null;
  section: string | null;
  sheet: string | null;
  cell_range: string | null;
  file_name: string;
  folder_name: string;
};

export async function embedPending(options: {
  embedder: KbEmbedder;
  /** After each batch; the sync stamps its heartbeat here. */
  onProgress?: (counts: KbEmbedCounts) => Promise<void>;
  /** Stop after this many passages (tests, a trial run). */
  limit?: number;
}): Promise<KbEmbedCounts> {
  const counts: KbEmbedCounts = { chunksEmbedded: 0, embeddingTokens: 0 };
  // Every batch either writes its passages or finds them gone (re-indexed
  // meanwhile), so the same passage never comes back and the loop ends.
  let sent = 0;

  for (;;) {
    const take = options.limit === undefined ? KB_EMBED_BATCH : Math.min(KB_EMBED_BATCH, options.limit - sent);
    if (take <= 0) break;
    const batch = await prisma.$queryRaw<Pending[]>`
      SELECT c.id::text, c.document_id::text, c.content, c.page_start, c.page_end, c.section,
             c.sheet, c.cell_range, d.file_name, p.folder_name
        FROM kb_chunks c
        JOIN kb_documents d ON d.id = c.document_id
        JOIN kb_projects p ON p.id = d.project_id
       WHERE c.embedding IS NULL
         AND d.status = 'indexed'
       ORDER BY d.is_latest DESC, d.id, c.ordinal
       LIMIT ${take}`;
    if (batch.length === 0) break;
    sent += batch.length;

    const { vectors, tokens } = await options.embedder(
      batch.map((b) =>
        embeddingInput({
          content: b.content,
          fileName: b.file_name,
          projectFolder: b.folder_name,
          pageStart: b.page_start,
          pageEnd: b.page_end,
          section: b.section,
          sheet: b.sheet,
          cellRange: b.cell_range,
        }),
      ),
    );

    const ids = batch.map((b) => b.id);
    const literals = vectors.map((v) => toVectorLiteral(v));
    const written = await prisma.$executeRaw`
      UPDATE kb_chunks AS c
         SET embedding = v.embedding::vector, embedding_model = ${KB_EMBEDDING_MODEL}
        FROM unnest(${ids}::uuid[], ${literals}::text[]) AS v(id, embedding)
       WHERE c.id = v.id AND c.embedding IS NULL`;

    // A document is embedded when none of its passages is left without a vector.
    const documents = [...new Set(batch.map((b) => b.document_id))];
    await prisma.$executeRaw`
      UPDATE kb_documents AS d
         SET embedding_model = ${KB_EMBEDDING_MODEL}
       WHERE d.id = ANY(${documents}::uuid[])
         AND NOT EXISTS (SELECT 1 FROM kb_chunks c WHERE c.document_id = d.id AND c.embedding IS NULL)`;

    counts.chunksEmbedded += written;
    counts.embeddingTokens += tokens;
    await options.onProgress?.(counts);
  }
  return counts;
}
