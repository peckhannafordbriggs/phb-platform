-- CreateTable
CREATE TABLE "cip_runs" (
    "id" BIGSERIAL NOT NULL,
    "workflow_id" BIGINT,
    "workflow_name" TEXT NOT NULL,
    "project_id" BIGINT NOT NULL,
    "steps" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "current_step" INTEGER NOT NULL DEFAULT 0,
    "session_id" TEXT,
    "model" TEXT NOT NULL,
    "budget_usd" DECIMAL(10,2) NOT NULL,
    "cost_usd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "input_tokens" BIGINT NOT NULL DEFAULT 0,
    "output_tokens" BIGINT NOT NULL DEFAULT 0,
    "error" TEXT,
    "started_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "heartbeat_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "cip_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cip_run_events" (
    "id" BIGSERIAL NOT NULL,
    "run_id" BIGINT NOT NULL,
    "step" INTEGER,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cip_run_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cip_run_checkpoints" (
    "id" BIGSERIAL NOT NULL,
    "run_id" BIGINT NOT NULL,
    "step" INTEGER NOT NULL,
    "question" TEXT NOT NULL,
    "options" JSONB NOT NULL DEFAULT '[]',
    "answer" TEXT,
    "answered_by_id" UUID,
    "asked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answered_at" TIMESTAMPTZ(3),

    CONSTRAINT "cip_run_checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cip_run_transcripts" (
    "id" BIGSERIAL NOT NULL,
    "run_id" BIGINT NOT NULL,
    "session_id" TEXT NOT NULL,
    "subpath" TEXT NOT NULL DEFAULT '',
    "entry_uuid" TEXT,
    "entry" JSONB NOT NULL,

    CONSTRAINT "cip_run_transcripts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cip_runs_created_at_idx" ON "cip_runs"("created_at" DESC);

-- CreateIndex
CREATE INDEX "cip_runs_status_idx" ON "cip_runs"("status");

-- CreateIndex
CREATE INDEX "cip_run_events_run_id_id_idx" ON "cip_run_events"("run_id", "id");

-- CreateIndex
CREATE INDEX "cip_run_checkpoints_run_id_idx" ON "cip_run_checkpoints"("run_id");

-- CreateIndex
CREATE INDEX "cip_run_transcripts_run_id_session_id_subpath_id_idx" ON "cip_run_transcripts"("run_id", "session_id", "subpath", "id");

-- AddForeignKey
ALTER TABLE "cip_runs" ADD CONSTRAINT "cip_runs_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "cip_workflows"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cip_runs" ADD CONSTRAINT "cip_runs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "cip_projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cip_runs" ADD CONSTRAINT "cip_runs_started_by_id_fkey" FOREIGN KEY ("started_by_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cip_run_events" ADD CONSTRAINT "cip_run_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "cip_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cip_run_checkpoints" ADD CONSTRAINT "cip_run_checkpoints_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "cip_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cip_run_checkpoints" ADD CONSTRAINT "cip_run_checkpoints_answered_by_id_fkey" FOREIGN KEY ("answered_by_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cip_run_transcripts" ADD CONSTRAINT "cip_run_transcripts_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "cip_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddCheckConstraint
ALTER TABLE "cip_runs" ADD CONSTRAINT "cip_runs_status_check" CHECK ("status" IN ('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled'));

-- AddCheckConstraint
ALTER TABLE "cip_runs" ADD CONSTRAINT "cip_runs_budget_check" CHECK ("budget_usd" > 0 AND "cost_usd" >= 0 AND "current_step" >= 0);

-- One active run per project, so two runs never write the same _revN into AI FILES.
CREATE UNIQUE INDEX "cip_runs_one_active_per_project_key" ON "cip_runs"("project_id") WHERE "status" IN ('queued', 'running', 'waiting');

-- One open question per run at a time.
CREATE UNIQUE INDEX "cip_run_checkpoints_one_open_key" ON "cip_run_checkpoints"("run_id") WHERE "answered_at" IS NULL;

-- SessionStore.append() retries: an entry with a uuid is stored once.
CREATE UNIQUE INDEX "cip_run_transcripts_entry_uuid_key" ON "cip_run_transcripts"("run_id", "session_id", "subpath", "entry_uuid") WHERE "entry_uuid" IS NOT NULL;
