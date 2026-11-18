-- Knowledge Base: the search index and the question history.
--
-- THE INDEX (kb_projects, kb_documents, kb_chunks, kb_sync_runs) is DERIVED
-- from the SharePoint legacy projects folder and can be truncated and rebuilt
-- by re-running the sync. THE HISTORY (kb_conversations, kb_questions,
-- kb_question_sources, kb_answer_reports) is the platform's own record of
-- what it told an employee, kept centrally and indefinitely, and survives a
-- rebuild. docs/KB-P0-P1.md.
--
-- PRECONDITION: pgvector must be ALLOW-LISTED (Azure: server parameter
-- azure.extensions includes VECTOR, infra/main.bicep) or INSTALLED (local, CI:
-- pgvector/pgvector:pg17) before this runs, or `migrate deploy` stops here and
-- blocks every later deploy. runbook.md -> *A migration fails with "extension
-- "vector" is not allow-listed"*.

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateEnum
CREATE TYPE "KbSourceKind" AS ENUM ('sharepoint', 'local');

-- CreateEnum
CREATE TYPE "KbDocumentStatus" AS ENUM ('pending', 'indexed', 'skipped', 'failed');

-- CreateEnum
CREATE TYPE "KbSyncRunStatus" AS ENUM ('running', 'ok', 'partial', 'failed');

-- CreateTable
CREATE TABLE "kb_projects" (
    "id" UUID NOT NULL,
    "source_kind" "KbSourceKind" NOT NULL,
    "source_id" TEXT NOT NULL,
    "folder_name" TEXT NOT NULL,
    "project_number" TEXT,
    "name" TEXT NOT NULL,
    "web_url" TEXT,
    "is_legacy" BOOLEAN NOT NULL DEFAULT false,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "kb_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kb_documents" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "source_kind" "KbSourceKind" NOT NULL,
    "source_id" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_type" TEXT NOT NULL,
    "web_url" TEXT,
    "etag" TEXT,
    "content_sha256" TEXT,
    "size_bytes" BIGINT,
    "source_modified_at" TIMESTAMPTZ(3),
    "folder_code" TEXT,
    "family_key" TEXT NOT NULL,
    "version_label" TEXT,
    "is_latest" BOOLEAN NOT NULL DEFAULT true,
    "status" "KbDocumentStatus" NOT NULL DEFAULT 'pending',
    "skip_reason" TEXT,
    "error" TEXT,
    "chunk_count" INTEGER NOT NULL DEFAULT 0,
    "embedding_model" TEXT,
    "indexed_at" TIMESTAMPTZ(3),
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "kb_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kb_chunks" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "page_start" INTEGER,
    "page_end" INTEGER,
    "section" TEXT,
    "sheet" TEXT,
    "cell_range" TEXT,
    "token_count" INTEGER,
    "embedding" vector(1536),
    "embedding_model" TEXT,
    "content_tsv" tsvector,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kb_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kb_sync_runs" (
    "id" UUID NOT NULL,
    "source_kind" "KbSourceKind" NOT NULL,
    "status" "KbSyncRunStatus" NOT NULL DEFAULT 'running',
    "trigger" TEXT NOT NULL,
    "triggered_by_id" UUID,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),
    "embedding_model" TEXT,
    "projects_seen" INTEGER NOT NULL DEFAULT 0,
    "files_seen" INTEGER NOT NULL DEFAULT 0,
    "files_indexed" INTEGER NOT NULL DEFAULT 0,
    "files_unchanged" INTEGER NOT NULL DEFAULT 0,
    "files_skipped" INTEGER NOT NULL DEFAULT 0,
    "files_failed" INTEGER NOT NULL DEFAULT 0,
    "files_removed" INTEGER NOT NULL DEFAULT 0,
    "chunks_written" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "kb_sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kb_conversations" (
    "id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "kb_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kb_questions" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "question" TEXT NOT NULL,
    "scope_project_ids" UUID[],
    "scope_how" TEXT NOT NULL,
    "answer_kind" TEXT NOT NULL,
    "answer" JSONB NOT NULL,
    "model" TEXT,
    "duration_ms" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kb_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kb_question_sources" (
    "question_id" UUID NOT NULL,
    "n" INTEGER NOT NULL,
    "document_id" UUID,
    "chunk_id" UUID,

    CONSTRAINT "kb_question_sources_pkey" PRIMARY KEY ("question_id","n")
);

-- CreateTable
CREATE TABLE "kb_answer_reports" (
    "id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "reported_by_id" UUID,
    "reason" TEXT NOT NULL,
    "citation_n" INTEGER,
    "comment" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolved_by_id" UUID,
    "resolution_note" TEXT,
    "resolved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "kb_answer_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "kb_projects_project_number_idx" ON "kb_projects"("project_number");

-- CreateIndex
CREATE UNIQUE INDEX "kb_projects_source_kind_source_id_key" ON "kb_projects"("source_kind", "source_id");

-- CreateIndex
CREATE INDEX "kb_documents_project_id_family_key_idx" ON "kb_documents"("project_id", "family_key");

-- CreateIndex
CREATE INDEX "kb_documents_status_idx" ON "kb_documents"("status");

-- CreateIndex
CREATE UNIQUE INDEX "kb_documents_source_kind_source_id_key" ON "kb_documents"("source_kind", "source_id");

-- CreateIndex
CREATE INDEX "kb_chunks_content_tsv_idx" ON "kb_chunks" USING GIN ("content_tsv");

-- CreateIndex
CREATE UNIQUE INDEX "kb_chunks_document_id_ordinal_key" ON "kb_chunks"("document_id", "ordinal");

-- CreateIndex
CREATE INDEX "kb_sync_runs_started_at_idx" ON "kb_sync_runs"("started_at" DESC);

-- CreateIndex
CREATE INDEX "kb_conversations_employee_id_updated_at_idx" ON "kb_conversations"("employee_id", "updated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "kb_questions_conversation_id_ordinal_key" ON "kb_questions"("conversation_id", "ordinal");

-- CreateIndex
CREATE INDEX "kb_question_sources_document_id_idx" ON "kb_question_sources"("document_id");

-- CreateIndex
CREATE INDEX "kb_answer_reports_status_created_at_idx" ON "kb_answer_reports"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "kb_answer_reports_question_id_idx" ON "kb_answer_reports"("question_id");

-- AddForeignKey
ALTER TABLE "kb_documents" ADD CONSTRAINT "kb_documents_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "kb_projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_chunks" ADD CONSTRAINT "kb_chunks_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "kb_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_sync_runs" ADD CONSTRAINT "kb_sync_runs_triggered_by_id_fkey" FOREIGN KEY ("triggered_by_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_conversations" ADD CONSTRAINT "kb_conversations_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_questions" ADD CONSTRAINT "kb_questions_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "kb_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_question_sources" ADD CONSTRAINT "kb_question_sources_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "kb_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_question_sources" ADD CONSTRAINT "kb_question_sources_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "kb_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_question_sources" ADD CONSTRAINT "kb_question_sources_chunk_id_fkey" FOREIGN KEY ("chunk_id") REFERENCES "kb_chunks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_answer_reports" ADD CONSTRAINT "kb_answer_reports_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "kb_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_answer_reports" ADD CONSTRAINT "kb_answer_reports_reported_by_id_fkey" FOREIGN KEY ("reported_by_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kb_answer_reports" ADD CONSTRAINT "kb_answer_reports_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Everything below is invisible to Prisma. tests/kb-schema.test.ts asserts it.
-- ---------------------------------------------------------------------------

-- The vector index, cosine distance (`<=>`). Prisma cannot express HNSW, so
-- the NEXT `prisma migrate dev` will generate a DROP INDEX for it: delete that
-- line before committing. Without it every search is a sequential scan.
CREATE INDEX "kb_chunks_embedding_hnsw_idx"
    ON "kb_chunks" USING hnsw ("embedding" vector_cosine_ops);

-- Keyword search, the other half of retrieval: exact identifiers (RTU-9,
-- model and job numbers) that embeddings blur. A trigger, not a generated
-- column, because Prisma leaves triggers alone. 'simple': no stemming, so
-- "RTU-9" and "300" survive as tokens.
CREATE FUNCTION kb_chunks_set_tsv() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.content_tsv := to_tsvector('simple',
        concat_ws(' ', NEW.section, NEW.sheet, NEW.content));
    RETURN NEW;
END;
$$;

CREATE TRIGGER kb_chunks_tsv
    BEFORE INSERT OR UPDATE OF content, section, sheet ON "kb_chunks"
    FOR EACH ROW EXECUTE FUNCTION kb_chunks_set_tsv();

-- One sync at a time, the same rule as cip_project_syncs.
CREATE UNIQUE INDEX "kb_sync_runs_one_running_key"
    ON "kb_sync_runs"("status") WHERE "status" = 'running';

-- kb_documents: status and its explanation travel together.
ALTER TABLE "kb_documents" ADD CONSTRAINT "kb_documents_skip_reason_valid"
    CHECK (skip_reason IS NULL OR skip_reason IN (
        'archive_prefix', 'draft_prefix', 'restricted_folder', 'drawings_folder',
        'folder_readme', 'unsupported_type', 'too_large', 'empty_text'));

ALTER TABLE "kb_documents" ADD CONSTRAINT "kb_documents_skip_reason_iff_skipped"
    CHECK ((status = 'skipped') = (skip_reason IS NOT NULL));

ALTER TABLE "kb_documents" ADD CONSTRAINT "kb_documents_error_iff_failed"
    CHECK ((status = 'failed') = (error IS NOT NULL));

ALTER TABLE "kb_documents" ADD CONSTRAINT "kb_documents_chunks_only_when_indexed"
    CHECK (status = 'indexed' OR chunk_count = 0);

-- kb_chunks: locations are exact or absent, never half-stated.
-- Both ends or neither. Spelled out with IS NOT NULL because a comparison
-- with NULL is unknown, and a CHECK that is unknown passes: without it,
-- page_start = 3 with page_end NULL got through (tests/kb-schema.test.ts).
ALTER TABLE "kb_chunks" ADD CONSTRAINT "kb_chunks_page_range_valid"
    CHECK ((page_start IS NULL AND page_end IS NULL)
        OR (page_start IS NOT NULL AND page_end IS NOT NULL
            AND page_start >= 1 AND page_end >= page_start));

ALTER TABLE "kb_chunks" ADD CONSTRAINT "kb_chunks_cell_range_needs_sheet"
    CHECK (cell_range IS NULL OR sheet IS NOT NULL);

ALTER TABLE "kb_chunks" ADD CONSTRAINT "kb_chunks_model_with_embedding"
    CHECK ((embedding IS NULL) = (embedding_model IS NULL));

-- kb_sync_runs
ALTER TABLE "kb_sync_runs" ADD CONSTRAINT "kb_sync_runs_trigger_valid"
    CHECK (trigger IN ('manual', 'scheduled'));

-- kb_questions
ALTER TABLE "kb_questions" ADD CONSTRAINT "kb_questions_scope_how_valid"
    CHECK (scope_how IN ('all', 'chosen', 'from_question', 'follow_up'));

ALTER TABLE "kb_questions" ADD CONSTRAINT "kb_questions_answer_kind_valid"
    CHECK (answer_kind IN ('answered', 'no_evidence'));

ALTER TABLE "kb_questions" ADD CONSTRAINT "kb_questions_ordinal_valid"
    CHECK (ordinal >= 0);

ALTER TABLE "kb_question_sources" ADD CONSTRAINT "kb_question_sources_n_valid"
    CHECK (n >= 1);

-- kb_answer_reports: a closed set of reasons, and a resolution that is all or nothing.
ALTER TABLE "kb_answer_reports" ADD CONSTRAINT "kb_answer_reports_reason_valid"
    CHECK (reason IN ('wrong_fact', 'wrong_source', 'missing_source', 'outdated', 'other'));

ALTER TABLE "kb_answer_reports" ADD CONSTRAINT "kb_answer_reports_status_valid"
    CHECK (status IN ('open', 'resolved', 'dismissed'));

-- Not open exactly when it carries a resolver, a note and a time. A resolver
-- whose account is later removed leaves resolved_by_id NULL (ON DELETE SET
-- NULL), so the resolver is not part of the rule; the note and the time are.
ALTER TABLE "kb_answer_reports" ADD CONSTRAINT "kb_answer_reports_resolution_iff_closed"
    CHECK ((status = 'open' AND resolved_at IS NULL AND resolution_note IS NULL)
        OR (status <> 'open' AND resolved_at IS NOT NULL AND resolution_note IS NOT NULL));

ALTER TABLE "kb_answer_reports" ADD CONSTRAINT "kb_answer_reports_citation_valid"
    CHECK (citation_n IS NULL OR citation_n >= 1);

ALTER TABLE "kb_answer_reports" ADD CONSTRAINT "kb_answer_reports_comment_length"
    CHECK (comment IS NULL OR char_length(comment) <= 2000);

-- One open report per person per question: a second click is the same report.
CREATE UNIQUE INDEX "kb_answer_reports_one_open_per_reporter_key"
    ON "kb_answer_reports"("question_id", "reported_by_id") WHERE "status" = 'open';

COMMENT ON TABLE "kb_projects" IS
  'Knowledge Base: one row per project folder under the legacy projects root. DERIVED from SharePoint; '
  'safe to rebuild. Only is_legacy projects are searchable. docs/KB-P0-P1.md.';

COMMENT ON TABLE "kb_documents" IS
  'Knowledge Base: one row per file in a project folder, indexed or not. DERIVED from SharePoint; '
  'safe to rebuild. Never store the original file.';

COMMENT ON COLUMN "kb_documents"."skip_reason" IS
  'Why a file was deliberately left out. Values: lib/modules/knowledge-base/scope.ts.';

COMMENT ON COLUMN "kb_documents"."family_key" IS
  'Versions of one document share it: same project, folder and description, differing in the _vNN or _YYYYMMDD suffix.';

COMMENT ON TABLE "kb_chunks" IS
  'Knowledge Base: passages of indexed documents. DERIVED; safe to rebuild. Written with raw SQL: '
  'Prisma cannot write embedding or content_tsv.';

COMMENT ON COLUMN "kb_chunks"."embedding" IS
  'vector(1536). NULL until embedded. Searched by cosine (<=>) through kb_chunks_embedding_hnsw_idx, '
  'which Prisma cannot see and will try to drop.';

COMMENT ON COLUMN "kb_chunks"."content_tsv" IS
  'Kept by trigger kb_chunks_tsv from section, sheet and content, simple dictionary. Never written by application code.';

COMMENT ON TABLE "kb_sync_runs" IS
  'Knowledge Base: one row per sync, manual or scheduled. At most one running.';

COMMENT ON TABLE "kb_questions" IS
  'Knowledge Base history: one question and its final answer. NOT derived: the platform''s record of what it '
  'told an employee. answer holds the full snapshot, sources included, so it survives a rebuild of the index.';

COMMENT ON TABLE "kb_question_sources" IS
  'Knowledge Base history: each citation linked back into the index. Links go NULL on a rebuild; '
  'the snapshot in kb_questions.answer stays complete.';

COMMENT ON TABLE "kb_answer_reports" IS
  'Knowledge Base history: an employee''s report that an answer is wrong, worked by the platform admin. '
  'NOT derived. Open until resolved or dismissed with a note.';
