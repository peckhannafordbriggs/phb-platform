import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { KB_SKIP_REASONS } from "@/lib/modules/knowledge-base/scope";
import {
  KB_ANSWER_KINDS,
  KB_REPORT_REASONS,
  KB_REPORT_STATUSES,
  KB_SCOPE_HOW,
  KB_SYNC_TRIGGERS,
} from "@/lib/modules/knowledge-base/types";
import {
  KB_EMBEDDING_DIMENSIONS,
  toVectorLiteral,
} from "@/lib/modules/knowledge-base/vector";
import { disconnectDb, testDb } from "./db";
import { expectRejection, inRollback } from "./bas-fixture";

/**
 * The half of the Knowledge Base schema Prisma cannot see - the pgvector
 * column and its HNSW index, the tsvector trigger, the partial unique index
 * and the CHECKs - and the delete behaviour that keeps question history
 * readable after the index is rebuilt. Nothing else in the repository would
 * notice if a later migration dropped any of it, and Prisma's own `migrate
 * dev` will try to drop the HNSW index. docs/KB-P0-P1.md.
 *
 * Every test writes inside a rolled-back transaction, so nothing persists.
 */

afterAll(async () => {
  await disconnectDb();
});

type Tx = Parameters<Parameters<typeof inRollback>[0]>[0];

let counter = 0;
const next = () => (counter += 1);

async function one<T>(rows: Promise<T[]>): Promise<T> {
  const row = (await rows)[0];
  if (row === undefined) throw new Error("expected a row");
  return row;
}

async function insertProject(tx: Tx): Promise<string> {
  const n = next();
  const row = await one(
    tx.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO kb_projects (id, source_kind, source_id, folder_name, name, updated_at)
       VALUES (gen_random_uuid(), 'local', $1, $1, 'Zztest', now())
       RETURNING id::text AS id`,
      `999${String(n).padStart(3, "0")}_ZZTEST`,
    ),
  );
  return row.id;
}

interface DocOverrides {
  projectId?: string;
  status?: string;
  skipReason?: string | null;
  error?: string | null;
  chunkCount?: number;
  isArchived?: boolean;
  isLatest?: boolean;
}

async function insertDocument(tx: Tx, o: DocOverrides = {}): Promise<string> {
  const n = next();
  const projectId = o.projectId ?? (await insertProject(tx));
  const row = await one(
    tx.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO kb_documents
         (id, project_id, source_kind, source_id, path, file_name, file_type, family_key,
          status, skip_reason, error, chunk_count, is_archived, is_latest, updated_at)
       VALUES (gen_random_uuid(), $1::uuid, 'local', $2, $3, 'zztest.pdf', 'pdf', 'zztest',
               $4::"KbDocumentStatus", $5, $6, $7, $8, $9, now())
       RETURNING id::text AS id`,
      projectId,
      `zztest-${n}`,
      `11 - SUBMITTALS/zztest-${n}.pdf`,
      o.status ?? "indexed",
      o.skipReason ?? null,
      o.error ?? null,
      o.chunkCount ?? 0,
      o.isArchived ?? false,
      o.isLatest ?? true,
    ),
  );
  return row.id;
}

/** A unit vector along one axis, so cosine distances are exact. */
function axis(index: number): number[] {
  const v = new Array<number>(KB_EMBEDDING_DIMENSIONS).fill(0);
  v[index] = 1;
  return v;
}

interface ChunkFields {
  embedding?: number[] | null;
  section?: string | null;
  sheet?: string | null;
  cellRange?: string | null;
  pageStart?: number | null;
  pageEnd?: number | null;
}

async function insertChunk(
  tx: Tx,
  documentId: string,
  ordinal: number,
  content: string,
  f: ChunkFields = {},
): Promise<string> {
  const embedding = f.embedding ?? null;
  const row = await one(
    tx.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO kb_chunks
         (id, document_id, ordinal, content, embedding, embedding_model,
          section, sheet, cell_range, page_start, page_end)
       VALUES (gen_random_uuid(), $1::uuid, $2, $3, $4::vector, $5, $6, $7, $8, $9, $10)
       RETURNING id::text AS id`,
      documentId,
      ordinal,
      content,
      embedding === null ? null : toVectorLiteral(embedding),
      embedding === null ? null : "zztest-model",
      f.section ?? null,
      f.sheet ?? null,
      f.cellRange ?? null,
      f.pageStart ?? null,
      f.pageEnd ?? null,
    ),
  );
  return row.id;
}

async function insertEmployee(tx: Tx): Promise<string> {
  const n = next();
  const row = await one(
    tx.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO employees (id, email, first_name, last_name, updated_at)
       VALUES (gen_random_uuid(), $1, 'Zz', 'Test', now())
       RETURNING id::text AS id`,
      `kb-zztest-${n}@example.invalid`,
    ),
  );
  return row.id;
}

async function insertConversation(tx: Tx, employeeId?: string): Promise<string> {
  const row = await one(
    tx.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO kb_conversations (id, employee_id, updated_at)
       VALUES (gen_random_uuid(), $1::uuid, now())
       RETURNING id::text AS id`,
      employeeId ?? (await insertEmployee(tx)),
    ),
  );
  return row.id;
}

async function insertQuestion(
  tx: Tx,
  conversationId: string,
  ordinal: number,
  o: { scopeHow?: string; answerKind?: string } = {},
): Promise<string> {
  const row = await one(
    tx.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO kb_questions
         (id, conversation_id, ordinal, question, scope_project_ids, scope_how, answer_kind, answer)
       VALUES (gen_random_uuid(), $1::uuid, $2, 'zztest question?', '{}', $3, $4, $5::jsonb)
       RETURNING id::text AS id`,
      conversationId,
      ordinal,
      o.scopeHow ?? "all",
      o.answerKind ?? "answered",
      JSON.stringify({ statements: [], sources: [{ n: 1, passage: "snapshot" }] }),
    ),
  );
  return row.id;
}

async function count(tx: Tx, sql: string, ...params: unknown[]): Promise<number> {
  const row = await one(tx.$queryRawUnsafe<Array<{ n: number }>>(sql, ...params));
  return row.n;
}

/** The quoted values of a CHECK constraint, sorted. */
async function checkValues(name: string): Promise<string[]> {
  const rows = await testDb.$queryRaw<Array<{ def: string }>>`
    SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = ${name}`;
  return [...(rows[0]?.def ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1] ?? "").sort();
}

describe("pgvector", () => {
  it("is installed", async () => {
    const rows = await testDb.$queryRaw<Array<{ extversion: string }>>`
      SELECT extversion FROM pg_extension WHERE extname = 'vector'`;
    expect(rows).toHaveLength(1);
  });

  it("sizes the column to KB_EMBEDDING_DIMENSIONS", async () => {
    const rows = await testDb.$queryRaw<Array<{ type: string }>>`
      SELECT format_type(atttypid, atttypmod) AS type
        FROM pg_attribute
       WHERE attrelid = 'kb_chunks'::regclass AND attname = 'embedding'`;
    expect(rows[0]?.type).toBe(`vector(${KB_EMBEDDING_DIMENSIONS})`);
  });

  it("has the HNSW cosine index on the embedding", async () => {
    const rows = await testDb.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes
       WHERE tablename = 'kb_chunks' AND indexname = 'kb_chunks_embedding_hnsw_idx'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toMatch(/USING hnsw \(embedding vector_cosine_ops\)/);
  });

  it("orders chunks by cosine distance, skipping chunks not yet embedded", async () => {
    await inRollback(async (tx) => {
      const doc = await insertDocument(tx);
      await insertChunk(tx, doc, 0, "far", { embedding: axis(1) });
      await insertChunk(tx, doc, 1, "near", { embedding: axis(0) });
      await insertChunk(tx, doc, 2, "not embedded yet");

      const rows = await tx.$queryRawUnsafe<Array<{ content: string; distance: number }>>(
        `SELECT content, (embedding <=> $1::vector)::float8 AS distance
           FROM kb_chunks
          WHERE document_id = $2::uuid AND embedding IS NOT NULL
          ORDER BY embedding <=> $1::vector`,
        toVectorLiteral(axis(0)),
        doc,
      );
      expect(rows.map((r) => r.content)).toEqual(["near", "far"]);
      expect(rows[0]?.distance).toBeCloseTo(0, 6);
      expect(rows[1]?.distance).toBeCloseTo(1, 6);
    });
  });
});

describe("no migration drops what Prisma cannot see", () => {
  /**
   * `prisma migrate dev` generates `DROP INDEX "kb_chunks_embedding_hnsw_idx"`
   * in the next migration anyone authors, because the index is not in
   * schema.prisma. This is the check that it was deleted before commit.
   */
  it("keeps the HNSW index, the trigger and the extension", async () => {
    const dir = path.resolve(process.cwd(), "prisma/migrations");
    const entries = await readdir(dir, { withFileTypes: true });
    const offenders: string[] = [];
    for (const entry of entries.filter((e) => e.isDirectory())) {
      const raw = await readFile(path.join(dir, entry.name, "migration.sql"), "utf8");
      // Comments can name the statement they warn about; only SQL counts.
      const sql = raw.replace(/--.*$/gm, "");
      if (
        /DROP\s+INDEX[^;]*kb_chunks_embedding_hnsw_idx/i.test(sql) ||
        /DROP\s+TRIGGER[^;]*kb_chunks_tsv/i.test(sql) ||
        /DROP\s+EXTENSION[^;]*vector/i.test(sql)
      ) {
        offenders.push(entry.name);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("content_tsv is maintained by the trigger", () => {
  it("indexes exact identifiers without stemming them away", async () => {
    await inRollback(async (tx) => {
      const doc = await insertDocument(tx);
      await insertChunk(tx, doc, 0, "Packaged RTU-9 rated 300 tons");
      const n = await count(
        tx,
        `SELECT count(*)::int AS n FROM kb_chunks
          WHERE document_id = $1::uuid
            AND content_tsv @@ plainto_tsquery('simple', 'RTU-9 300')`,
        doc,
      );
      expect(n).toBe(1);
    });
  });

  it("makes a spreadsheet's sheet name searchable", async () => {
    await inRollback(async (tx) => {
      const doc = await insertDocument(tx);
      await insertChunk(tx, doc, 0, "4 | Acoustic screen | $48,600", { sheet: "CO Log", cellRange: "A9:F9" });
      const n = await count(
        tx,
        `SELECT count(*)::int AS n FROM kb_chunks
          WHERE document_id = $1::uuid AND content_tsv @@ plainto_tsquery('simple', 'log')`,
        doc,
      );
      expect(n).toBe(1);
    });
  });

  it("follows an UPDATE of the content", async () => {
    await inRollback(async (tx) => {
      const doc = await insertDocument(tx);
      await insertChunk(tx, doc, 0, "chiller");
      await tx.$executeRawUnsafe(`UPDATE kb_chunks SET content = 'boiler' WHERE document_id = $1::uuid`, doc);
      const row = await one(
        tx.$queryRawUnsafe<Array<{ tsv: string }>>(
          `SELECT content_tsv::text AS tsv FROM kb_chunks WHERE document_id = $1::uuid`,
          doc,
        ),
      );
      expect(row.tsv).toBe("'boiler':1");
    });
  });
});

describe("closed vocabularies match their CHECKs", () => {
  it.each([
    ["kb_documents_skip_reason_valid", KB_SKIP_REASONS],
    ["kb_questions_scope_how_valid", KB_SCOPE_HOW],
    ["kb_questions_answer_kind_valid", KB_ANSWER_KINDS],
    ["kb_sync_runs_trigger_valid", KB_SYNC_TRIGGERS],
  ] as const)("%s", async (constraint, values) => {
    expect(await checkValues(constraint)).toEqual([...values].sort());
  });
});

describe("kb_documents", () => {
  it("refuses a skipped document with no reason", async () => {
    const error = await expectRejection(async (tx) => {
      await insertDocument(tx, { status: "skipped", skipReason: null });
    });
    expect(error.message).toMatch(/kb_documents_skip_reason_iff_skipped/);
  });

  it("refuses a reason on a document that was not skipped", async () => {
    const error = await expectRejection(async (tx) => {
      await insertDocument(tx, { status: "indexed", skipReason: "draft_prefix" });
    });
    expect(error.message).toMatch(/kb_documents_skip_reason_iff_skipped/);
  });

  it("refuses an unknown reason", async () => {
    const error = await expectRejection(async (tx) => {
      await insertDocument(tx, { status: "skipped", skipReason: "felt_like_it" });
    });
    expect(error.message).toMatch(/kb_documents_skip_reason_valid/);
  });

  it("refuses an archived document marked latest", async () => {
    const error = await expectRejection(async (tx) => {
      await insertDocument(tx, { isArchived: true, isLatest: true });
    });
    expect(error.message).toMatch(/kb_documents_archived_never_latest/);
  });

  it("accepts an archived document that is not latest", async () => {
    await inRollback(async (tx) => {
      await insertDocument(tx, { isArchived: true, isLatest: false });
    });
  });

  it("refuses a failed document with no error", async () => {
    const error = await expectRejection(async (tx) => {
      await insertDocument(tx, { status: "failed", error: null });
    });
    expect(error.message).toMatch(/kb_documents_error_iff_failed/);
  });

  it("refuses chunks on a document that is not indexed", async () => {
    const error = await expectRejection(async (tx) => {
      await insertDocument(tx, { status: "pending", chunkCount: 3 });
    });
    expect(error.message).toMatch(/kb_documents_chunks_only_when_indexed/);
  });

  it("goes with its project, and its chunks with it", async () => {
    await inRollback(async (tx) => {
      const project = await insertProject(tx);
      const doc = await insertDocument(tx, { projectId: project });
      await insertChunk(tx, doc, 0, "passage");
      await tx.$executeRawUnsafe(`DELETE FROM kb_projects WHERE id = $1::uuid`, project);
      expect(await count(tx, `SELECT count(*)::int AS n FROM kb_documents WHERE id = $1::uuid`, doc)).toBe(0);
      expect(await count(tx, `SELECT count(*)::int AS n FROM kb_chunks WHERE document_id = $1::uuid`, doc)).toBe(0);
    });
  });
});

describe("kb_chunks locations are exact or absent", () => {
  it("refuses a cell range with no sheet", async () => {
    const error = await expectRejection(async (tx) => {
      const doc = await insertDocument(tx);
      await insertChunk(tx, doc, 0, "x", { cellRange: "B4:F12" });
    });
    expect(error.message).toMatch(/kb_chunks_cell_range_needs_sheet/);
  });

  it("refuses half a page range", async () => {
    const error = await expectRejection(async (tx) => {
      const doc = await insertDocument(tx);
      await insertChunk(tx, doc, 0, "x", { pageStart: 3, pageEnd: null });
    });
    expect(error.message).toMatch(/kb_chunks_page_range_valid/);
  });

  it("refuses a page range that runs backwards", async () => {
    const error = await expectRejection(async (tx) => {
      const doc = await insertDocument(tx);
      await insertChunk(tx, doc, 0, "x", { pageStart: 5, pageEnd: 4 });
    });
    expect(error.message).toMatch(/kb_chunks_page_range_valid/);
  });

  it("accepts a chunk with no location at all", async () => {
    await inRollback(async (tx) => {
      const doc = await insertDocument(tx);
      await insertChunk(tx, doc, 0, "scanned, no positions");
    });
  });

  it("refuses an embedding without the model that made it", async () => {
    const error = await expectRejection(async (tx) => {
      const doc = await insertDocument(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO kb_chunks (id, document_id, ordinal, content, embedding)
         VALUES (gen_random_uuid(), $1::uuid, 0, 'x', $2::vector)`,
        doc,
        toVectorLiteral(axis(0)),
      );
    });
    expect(error.message).toMatch(/kb_chunks_model_with_embedding/);
  });

  it("refuses a vector of the wrong width", async () => {
    const error = await expectRejection(async (tx) => {
      const doc = await insertDocument(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO kb_chunks (id, document_id, ordinal, content, embedding, embedding_model)
         VALUES (gen_random_uuid(), $1::uuid, 0, 'x', '[1,0,0]'::vector, 'm')`,
        doc,
      );
    });
    expect(error.message).toMatch(/expected 1536 dimensions/);
  });
});

describe("kb_sync_runs", () => {
  it("allows only one running sync at a time", async () => {
    const error = await expectRejection(async (tx) => {
      for (let i = 0; i < 2; i += 1) {
        await tx.$executeRawUnsafe(
          `INSERT INTO kb_sync_runs (id, source_kind, trigger) VALUES (gen_random_uuid(), 'local', 'manual')`,
        );
      }
    });
    expect(error.message).toMatch(/kb_sync_runs_one_running_key/);
  });

  it("allows many finished syncs", async () => {
    await inRollback(async (tx) => {
      for (const status of ["ok", "partial", "failed", "running"]) {
        await tx.$executeRawUnsafe(
          `INSERT INTO kb_sync_runs (id, source_kind, trigger, status)
           VALUES (gen_random_uuid(), 'local', 'scheduled', $1::"KbSyncRunStatus")`,
          status,
        );
      }
    });
  });
});

describe("question history", () => {
  it("numbers the questions of a conversation without repeats", async () => {
    const error = await expectRejection(async (tx) => {
      const conversation = await insertConversation(tx);
      await insertQuestion(tx, conversation, 0);
      await insertQuestion(tx, conversation, 0);
    });
    expect(error.message).toMatch(/kb_questions_conversation_id_ordinal_key/);
  });

  it("refuses a scope or answer kind outside the vocabulary", async () => {
    const scope = await expectRejection(async (tx) => {
      await insertQuestion(tx, await insertConversation(tx), 0, { scopeHow: "guessed" });
    });
    expect(scope.message).toMatch(/kb_questions_scope_how_valid/);

    const kind = await expectRejection(async (tx) => {
      await insertQuestion(tx, await insertConversation(tx), 0, { answerKind: "error" });
    });
    expect(kind.message).toMatch(/kb_questions_answer_kind_valid/);
  });

  it("survives a rebuild of the index: the links go NULL, the snapshot stays", async () => {
    await inRollback(async (tx) => {
      const project = await insertProject(tx);
      const doc = await insertDocument(tx, { projectId: project });
      const chunk = await insertChunk(tx, doc, 0, "the cited passage");
      const question = await insertQuestion(tx, await insertConversation(tx), 0);
      await tx.$executeRawUnsafe(
        `INSERT INTO kb_question_sources (question_id, n, document_id, chunk_id)
         VALUES ($1::uuid, 1, $2::uuid, $3::uuid)`,
        question,
        doc,
        chunk,
      );

      // A rebuild truncates the index. The history is not part of it.
      await tx.$executeRawUnsafe(`DELETE FROM kb_projects WHERE id = $1::uuid`, project);

      const source = await one(
        tx.$queryRawUnsafe<Array<{ document_id: string | null; chunk_id: string | null }>>(
          `SELECT document_id::text, chunk_id::text FROM kb_question_sources WHERE question_id = $1::uuid`,
          question,
        ),
      );
      expect(source).toEqual({ document_id: null, chunk_id: null });

      const snapshot = await one(
        tx.$queryRawUnsafe<Array<{ passage: string }>>(
          `SELECT answer->'sources'->0->>'passage' AS passage FROM kb_questions WHERE id = $1::uuid`,
          question,
        ),
      );
      expect(snapshot.passage).toBe("snapshot");
    });
  });

  it("goes with its conversation", async () => {
    await inRollback(async (tx) => {
      const conversation = await insertConversation(tx);
      const question = await insertQuestion(tx, conversation, 0);
      await tx.$executeRawUnsafe(
        `INSERT INTO kb_question_sources (question_id, n) VALUES ($1::uuid, 1)`,
        question,
      );
      await tx.$executeRawUnsafe(`DELETE FROM kb_conversations WHERE id = $1::uuid`, conversation);
      expect(await count(tx, `SELECT count(*)::int AS n FROM kb_questions WHERE id = $1::uuid`, question)).toBe(0);
      expect(
        await count(tx, `SELECT count(*)::int AS n FROM kb_question_sources WHERE question_id = $1::uuid`, question),
      ).toBe(0);
    });
  });

  it("numbers citations from 1", async () => {
    const error = await expectRejection(async (tx) => {
      const question = await insertQuestion(tx, await insertConversation(tx), 0);
      await tx.$executeRawUnsafe(
        `INSERT INTO kb_question_sources (question_id, n) VALUES ($1::uuid, 0)`,
        question,
      );
    });
    expect(error.message).toMatch(/kb_question_sources_n_valid/);
  });
});

describe("answer reports", () => {
  async function report(
    tx: Tx,
    o: { questionId?: string; reporterId?: string; reason?: string; status?: string; note?: string | null; resolved?: boolean; citation?: number | null; comment?: string | null } = {},
  ): Promise<string> {
    const questionId = o.questionId ?? (await insertQuestion(tx, await insertConversation(tx), 0));
    const row = await one(
      tx.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO kb_answer_reports
           (id, question_id, reported_by_id, reason, citation_n, comment, status, resolution_note, resolved_at, updated_at)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5, $6, $7,
                 CASE WHEN $8 THEN now() ELSE NULL END, now())
         RETURNING id::text AS id`,
        questionId,
        o.reporterId ?? (await insertEmployee(tx)),
        o.reason ?? "wrong_fact",
        o.citation ?? null,
        o.comment ?? null,
        o.status ?? "open",
        o.note ?? null,
        o.resolved ?? false,
      ),
    );
    return row.id;
  }

  it.each([
    ["kb_answer_reports_reason_valid", KB_REPORT_REASONS],
    ["kb_answer_reports_status_valid", KB_REPORT_STATUSES],
  ] as const)("%s matches its constant", async (constraint, values) => {
    expect(await checkValues(constraint)).toEqual([...values].sort());
  });

  it("accepts an open report, and a closed one with its note and time", async () => {
    await inRollback(async (tx) => {
      await report(tx, { citation: 2, comment: "That screen was $46,800, not $48,600." });
      await report(tx, { status: "resolved", note: "Re-extracted the CO log.", resolved: true });
      await report(tx, { status: "dismissed", note: "The answer matches the file.", resolved: true });
    });
  });

  it.each([
    ["closed with no note", { status: "resolved", note: null, resolved: true }],
    ["closed with no time", { status: "dismissed", note: "checked", resolved: false }],
    ["open with a note", { status: "open", note: "half-resolved", resolved: false }],
  ] as const)("refuses a report %s", async (_label, o) => {
    const error = await expectRejection(async (tx) => {
      await report(tx, { ...o });
    });
    expect(error.message).toMatch(/kb_answer_reports_resolution_iff_closed/);
  });

  it("refuses an unknown reason, citation 0 and an essay", async () => {
    const reason = await expectRejection(async (tx) => {
      await report(tx, { reason: "vibes" });
    });
    expect(reason.message).toMatch(/kb_answer_reports_reason_valid/);

    const citation = await expectRejection(async (tx) => {
      await report(tx, { citation: 0 });
    });
    expect(citation.message).toMatch(/kb_answer_reports_citation_valid/);

    const essay = await expectRejection(async (tx) => {
      await report(tx, { comment: "x".repeat(2001) });
    });
    expect(essay.message).toMatch(/kb_answer_reports_comment_length/);
  });

  it("keeps one open report per person per question, and allows another once closed", async () => {
    const error = await expectRejection(async (tx) => {
      const questionId = await insertQuestion(tx, await insertConversation(tx), 0);
      const reporterId = await insertEmployee(tx);
      await report(tx, { questionId, reporterId });
      await report(tx, { questionId, reporterId });
    });
    expect(error.message).toMatch(/kb_answer_reports_one_open_per_reporter_key/);

    await inRollback(async (tx) => {
      const questionId = await insertQuestion(tx, await insertConversation(tx), 0);
      const reporterId = await insertEmployee(tx);
      await report(tx, { questionId, reporterId, status: "resolved", note: "fixed", resolved: true });
      await report(tx, { questionId, reporterId });
    });
  });

  it("outlives a rebuild of the index", async () => {
    await inRollback(async (tx) => {
      const project = await insertProject(tx);
      const doc = await insertDocument(tx, { projectId: project });
      const chunk = await insertChunk(tx, doc, 0, "cited");
      const questionId = await insertQuestion(tx, await insertConversation(tx), 0);
      await tx.$executeRawUnsafe(
        `INSERT INTO kb_question_sources (question_id, n, document_id, chunk_id) VALUES ($1::uuid, 1, $2::uuid, $3::uuid)`,
        questionId,
        doc,
        chunk,
      );
      const id = await report(tx, { questionId, citation: 1 });
      await tx.$executeRawUnsafe(`DELETE FROM kb_projects WHERE id = $1::uuid`, project);
      expect(await count(tx, `SELECT count(*)::int AS n FROM kb_answer_reports WHERE id = $1::uuid`, id)).toBe(1);
    });
  });
});
