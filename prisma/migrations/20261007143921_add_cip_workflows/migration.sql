-- CreateTable
CREATE TABLE "cip_workflows" (
    "id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cip_workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cip_workflow_steps" (
    "id" BIGSERIAL NOT NULL,
    "workflow_id" BIGINT NOT NULL,
    "position" INTEGER NOT NULL,
    "skill_folder_name" TEXT NOT NULL,

    CONSTRAINT "cip_workflow_steps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cip_workflow_steps_workflow_id_position_key" ON "cip_workflow_steps"("workflow_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "cip_workflow_steps_workflow_id_skill_folder_name_key" ON "cip_workflow_steps"("workflow_id", "skill_folder_name");

-- AddForeignKey
ALTER TABLE "cip_workflows" ADD CONSTRAINT "cip_workflows_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cip_workflow_steps" ADD CONSTRAINT "cip_workflow_steps_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "cip_workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Only the three statuses the service knows.
ALTER TABLE "cip_workflows" ADD CONSTRAINT "cip_workflows_status_check"
  CHECK ("status" IN ('draft', 'active', 'paused'));

-- A name must have something in it.
ALTER TABLE "cip_workflows" ADD CONSTRAINT "cip_workflows_name_not_blank"
  CHECK (btrim("name") <> '');

-- Names are unique ignoring case: "Bid kickoff" and "bid kickoff" cannot both exist.
CREATE UNIQUE INDEX "cip_workflows_name_lower_key" ON "cip_workflows" (lower("name"));

-- Steps are numbered from 1.
ALTER TABLE "cip_workflow_steps" ADD CONSTRAINT "cip_workflow_steps_position_check"
  CHECK ("position" >= 1);
