-- Knowledge Base: the admin's Index button asks the worker job for a sync by
-- writing a `queued` kb_sync_runs row; the worker claims it and it becomes
-- `running`. A migration of its own: PostgreSQL does not let a new enum value
-- be used in the transaction that adds it, and the next migration's index
-- names it. lib/modules/knowledge-base/sync.ts -> queueKbSync.

ALTER TYPE "KbSyncRunStatus" ADD VALUE IF NOT EXISTS 'queued' BEFORE 'running';
