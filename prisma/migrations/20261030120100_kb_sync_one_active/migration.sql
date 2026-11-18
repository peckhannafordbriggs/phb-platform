-- One active Knowledge Base sync at a time, queued or running. A second press
-- of the Index button while one waits or works is refused (P2002 ->
-- KbSyncInProgressError) rather than queuing a second full pass. The older
-- kb_sync_runs_one_running_key stays: it says the narrower thing, and
-- tests/kb-schema.test.ts checks both.
--
-- The indexed expression is a constant, so every row the predicate admits has
-- the same key and at most one can exist.

CREATE UNIQUE INDEX "kb_sync_runs_one_active_key"
    ON "kb_sync_runs" ((true))
    WHERE "status" IN ('queued', 'running');

-- The worker job's scaler polls this every 15 seconds.
CREATE INDEX "kb_sync_runs_queued_idx" ON "kb_sync_runs" ("started_at") WHERE "status" = 'queued';
