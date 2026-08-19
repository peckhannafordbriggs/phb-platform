-- The advisory lock table for draft editing.
--
-- The only table Phase 6 adds, and deliberately the smallest one that does the
-- job: a message id, a holder, and an expiry. No subject, no recipients, no
-- body. Nothing about the mailbox is persisted anywhere in this platform, and
-- dropping this table loses nothing but a few seconds of coordination.
--
-- Advisory in the strict sense. It coordinates the platform with itself.
-- Outlook holds no lock and can still overwrite a draft at any moment - Graph
-- offers no useful concurrency control here, so the UI tells the user that
-- rather than pretending to prevent it.
--
-- message_id is the IMMUTABLE Graph id. That is the point: it survives Power
-- Automate moving the message between folders, which it does constantly.
--
-- Expiry is the release mechanism rather than an explicit unlock, because a
-- closed browser tab never sends one and a stranded lock on the draft someone
-- needs to send is worse than a lock that lapses early.

-- CreateTable
CREATE TABLE "draft_locks" (
    "message_id" TEXT NOT NULL,
    "held_by_id" UUID NOT NULL,
    "acquired_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "draft_locks_pkey" PRIMARY KEY ("message_id")
);

-- CreateIndex
CREATE INDEX "draft_locks_expires_at_idx" ON "draft_locks"("expires_at");

-- CreateIndex
CREATE INDEX "draft_locks_held_by_id_idx" ON "draft_locks"("held_by_id");

-- AddForeignKey
ALTER TABLE "draft_locks" ADD CONSTRAINT "draft_locks_held_by_id_fkey" FOREIGN KEY ("held_by_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;
