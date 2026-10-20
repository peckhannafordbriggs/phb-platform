-- The project's file tree as of the last sync, so the Projects page reads it
-- from here instead of walking the SharePoint folder on every view.
-- AlterTable
ALTER TABLE "cip_projects" ADD COLUMN "file_tree" JSONB;
