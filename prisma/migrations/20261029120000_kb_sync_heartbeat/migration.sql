-- Knowledge Base: a sync that indexes runs for minutes to hours, so "running
-- too long" can no longer tell a crashed sync from a busy one. The sync stamps
-- heartbeat_at as it works; a running row whose last sign of life (the
-- heartbeat, or the start when there is none) is older than ten minutes is
-- abandoned. lib/modules/knowledge-base/sync.ts.

ALTER TABLE "kb_sync_runs" ADD COLUMN "heartbeat_at" TIMESTAMPTZ(3);

COMMENT ON COLUMN "kb_sync_runs"."heartbeat_at" IS
    'Last sign of life from a running sync. A running row silent for ten minutes is abandoned by the next sync.';
