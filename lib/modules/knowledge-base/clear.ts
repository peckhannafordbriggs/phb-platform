import { writeAuditEvent } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { KNOWLEDGE_BASE_MODULE_KEY } from "./constants";
import { KbSyncInProgressError } from "./sync";

/**
 * Empties the index - every project, document, passage and vector - so the
 * next sync rebuilds it from the library. The admin's "Clear index" button.
 *
 * What it keeps, deliberately:
 * - The question history (kb_conversations, kb_questions, kb_question_sources,
 *   kb_answer_reports). It is the platform's own record, not derived; each
 *   answer keeps its snapshot and only its links into the index go NULL
 *   (ON DELETE SET NULL). This is a DELETE through the foreign keys, never a
 *   TRUNCATE ... CASCADE, which would empty kb_question_sources with it.
 * - kb_sync_runs: the record of what ran, which is what explains the rebuild.
 *
 * Refused while a sync is queued or running. kb_sync_runs is locked against
 * writes for the length of the transaction, so a sync cannot be queued or
 * start between the check and the delete.
 *
 * The cost of a rebuild is the next sync reading every file again and
 * re-embedding every passage.
 */

/** The word the admin types to confirm. The route checks it too. */
export const KB_CLEAR_CONFIRMATION = "clear";

export type KbClearOutcome = { projects: number; documents: number; chunks: number };

export async function clearKbIndex(options: { actorId: string | null }): Promise<KbClearOutcome> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`LOCK TABLE kb_sync_runs IN SHARE ROW EXCLUSIVE MODE`);
      const active = await tx.kbSyncRun.count({ where: { status: { in: ["queued", "running"] } } });
      if (active > 0) throw new KbSyncInProgressError();

      const [documents, chunks] = await Promise.all([tx.kbDocument.count(), tx.kbChunk.count()]);
      const projects = (await tx.kbProject.deleteMany({})).count;
      const outcome = { projects, documents, chunks };

      await writeAuditEvent(tx, {
        action: "kb.index_cleared",
        actorEmployeeId: options.actorId,
        moduleKey: KNOWLEDGE_BASE_MODULE_KEY,
        metadata: outcome,
      });
      return outcome;
    },
    // Tens of thousands of passages cascade; well past the 5 s default.
    { timeout: 120_000 },
  );
}
