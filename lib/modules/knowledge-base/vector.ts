/**
 * The embedding column is `vector(1536)` (kb_chunks.embedding). 1536 is the
 * native width of Azure OpenAI's text-embedding-3-small, the model chosen in
 * docs/KB-P0-P1.md. Changing model or width is a migration that alters the
 * column and rebuilds the HNSW index, plus a full re-embed - never a change to
 * this constant alone. tests/kb-schema.test.ts reads the width back from the
 * catalog and fails if the two disagree.
 */
export const KB_EMBEDDING_DIMENSIONS = 1536;

/**
 * Serialises an embedding as a pgvector text literal, for a parameter in raw
 * SQL: `$1::vector`. Prisma cannot write the column itself.
 *
 * Refuses rather than repairs. A short vector would fail in PostgreSQL with a
 * message that names no document; NaN or Infinity would be stored and then
 * poison every distance computed against it.
 */
export function toVectorLiteral(values: readonly number[]): string {
  if (values.length !== KB_EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Embedding has ${values.length} dimensions; kb_chunks.embedding is ` +
        `vector(${KB_EMBEDDING_DIMENSIONS}).`,
    );
  }
  for (let i = 0; i < values.length; i += 1) {
    if (!Number.isFinite(values[i])) {
      throw new Error(`Embedding value ${i} is not a finite number.`);
    }
  }
  return `[${values.join(",")}]`;
}
