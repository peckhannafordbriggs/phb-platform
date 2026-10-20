-- CreateTable
CREATE TABLE "cip_skills" (
    "id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "location_path" TEXT NOT NULL,
    "folder_name" TEXT NOT NULL,
    "last_modified" TIMESTAMPTZ(3) NOT NULL,
    "last_synced" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cip_skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cip_skill_syncs" (
    "id" BIGSERIAL NOT NULL,
    "trigger" TEXT NOT NULL,
    "triggered_by_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'running',
    "skills_seen" INTEGER NOT NULL DEFAULT 0,
    "skills_added" INTEGER NOT NULL DEFAULT 0,
    "skills_updated" INTEGER NOT NULL DEFAULT 0,
    "skills_deleted" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),
    "errors" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "cip_skill_syncs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cip_skills_folder_name_key" ON "cip_skills"("folder_name");

-- CreateIndex
CREATE INDEX "cip_skill_syncs_started_at_idx" ON "cip_skill_syncs"("started_at" DESC);

-- AddForeignKey
ALTER TABLE "cip_skill_syncs" ADD CONSTRAINT "cip_skill_syncs_triggered_by_id_fkey" FOREIGN KEY ("triggered_by_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddCheckConstraint
ALTER TABLE "cip_skill_syncs" ADD CONSTRAINT "cip_skill_syncs_status_check" CHECK ("status" IN ('running', 'ok', 'partial', 'failed'));

-- AddCheckConstraint
ALTER TABLE "cip_skill_syncs" ADD CONSTRAINT "cip_skill_syncs_trigger_check" CHECK ("trigger" IN ('manual', 'scheduled'));

-- CreateIndex
CREATE UNIQUE INDEX "cip_skill_syncs_one_running_key" ON "cip_skill_syncs"("status") WHERE "status" = 'running';
