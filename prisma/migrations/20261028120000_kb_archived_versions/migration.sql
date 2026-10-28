-- Knowledge Base: archived versions are indexed, not skipped.
--
-- ARCHIVE_ files are superseded or rejected versions. They are now indexed and
-- tagged, so an answer never leads with one but can use it to explain what
-- changed. A new migration rather than an edit to 20261027120000_add_kb_index,
-- because an applied migration's edits never reach a database that has run it.
-- docs/KB-P0-P1.md -> *Decisions taken*.

ALTER TABLE "kb_documents" ADD COLUMN "is_archived" BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN "kb_documents"."is_archived" IS
    'An ARCHIVE_ file: a superseded or rejected version. Indexed, never the latest. Derived from the file name.';

-- An archived file is never the current version of its family. A family whose
-- every member is archived has no latest at all.
ALTER TABLE "kb_documents" ADD CONSTRAINT "kb_documents_archived_never_latest"
    CHECK (NOT (is_archived AND is_latest));

-- The skip reasons follow lib/modules/knowledge-base/scope.ts: archive_prefix
-- is gone (archived files are indexed), drawings_folder became drawings
-- (it also covers _Drawings_ files outside 1A and 1D), and project_root_file
-- is new. Existing rows are rewritten first so the new CHECK can be added;
-- the next sync re-decides every file anyway.
ALTER TABLE "kb_documents" DROP CONSTRAINT "kb_documents_skip_reason_valid";

UPDATE "kb_documents" SET skip_reason = 'drawings' WHERE skip_reason = 'drawings_folder';

UPDATE "kb_documents"
   SET status = 'pending', skip_reason = NULL, is_archived = true, is_latest = false
 WHERE skip_reason = 'archive_prefix';

ALTER TABLE "kb_documents" ADD CONSTRAINT "kb_documents_skip_reason_valid"
    CHECK (skip_reason IS NULL OR skip_reason IN (
        'draft_prefix', 'restricted_folder', 'drawings', 'folder_readme',
        'project_root_file', 'unsupported_type', 'too_large', 'empty_text'));
