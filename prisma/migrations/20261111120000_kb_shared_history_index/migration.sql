-- The shared Knowledge Base history (2026-11-11): every KB user sees every
-- conversation, newest activity first, paged by (updated_at, id). The
-- existing index leads with employee_id, which serves "mine" and not this.
CREATE INDEX "kb_conversations_updated_at_id_idx" ON "kb_conversations"("updated_at" DESC, "id" DESC);
