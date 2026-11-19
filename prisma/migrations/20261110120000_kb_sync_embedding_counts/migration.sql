-- Knowledge Base: a sync now ends by embedding every passage that has no
-- vector yet (lib/modules/knowledge-base/embedder.ts). What it did is recorded
-- beside the other counts: how many passages it embedded, and how many tokens
-- Azure OpenAI counted for them - the figure the deployment's quota and the
-- bill see. kb_sync_runs.embedding_model (from 20261027120000) names the model.

ALTER TABLE "kb_sync_runs"
    ADD COLUMN "chunks_embedded" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "embedding_tokens" INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN "kb_sync_runs"."chunks_embedded" IS
    'Passages this sync gave a vector to. Passages left without one are embedded by the next sync.';
COMMENT ON COLUMN "kb_sync_runs"."embedding_tokens" IS
    'Tokens Azure OpenAI counted for this sync''s embeddings (its usage.total_tokens, summed).';
