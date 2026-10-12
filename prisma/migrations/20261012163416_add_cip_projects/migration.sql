-- CreateTable
CREATE TABLE "cip_projects" (
    "id" BIGSERIAL NOT NULL,
    "folder_name" TEXT NOT NULL,
    "location_path" TEXT NOT NULL,
    "categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "file_count" INTEGER NOT NULL,
    "total_bytes" BIGINT NOT NULL,
    "last_modified" TIMESTAMPTZ(3),
    "ai_file_count" INTEGER,
    "last_synced" TIMESTAMPTZ(3) NOT NULL,
    "removed_at" TIMESTAMPTZ(3),

    CONSTRAINT "cip_projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cip_project_syncs" (
    "id" BIGSERIAL NOT NULL,
    "trigger" TEXT NOT NULL,
    "triggered_by_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'running',
    "projects_seen" INTEGER NOT NULL DEFAULT 0,
    "projects_added" INTEGER NOT NULL DEFAULT 0,
    "projects_updated" INTEGER NOT NULL DEFAULT 0,
    "projects_removed" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),
    "errors" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "cip_project_syncs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cip_projects_folder_name_key" ON "cip_projects"("folder_name");

-- CreateIndex
CREATE INDEX "cip_project_syncs_started_at_idx" ON "cip_project_syncs"("started_at" DESC);

-- AddForeignKey
ALTER TABLE "cip_project_syncs" ADD CONSTRAINT "cip_project_syncs_triggered_by_id_fkey" FOREIGN KEY ("triggered_by_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddCheckConstraint
ALTER TABLE "cip_projects" ADD CONSTRAINT "cip_projects_counts_check" CHECK ("file_count" >= 0 AND "total_bytes" >= 0 AND ("ai_file_count" IS NULL OR "ai_file_count" >= 0));

-- AddCheckConstraint
ALTER TABLE "cip_project_syncs" ADD CONSTRAINT "cip_project_syncs_status_check" CHECK ("status" IN ('running', 'ok', 'partial', 'failed'));

-- AddCheckConstraint
ALTER TABLE "cip_project_syncs" ADD CONSTRAINT "cip_project_syncs_trigger_check" CHECK ("trigger" IN ('manual', 'scheduled'));

-- CreateIndex
CREATE UNIQUE INDEX "cip_project_syncs_one_running_key" ON "cip_project_syncs"("status") WHERE "status" = 'running';
