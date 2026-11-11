import { writeAuditEvent } from "@/lib/audit";
import { prisma } from "@/lib/db";
import type { KbAnswerSnapshot } from "./ask";
import { KNOWLEDGE_BASE_MODULE_KEY } from "./constants";
import type { KbReportReason, KbReportStatus } from "./types";

/**
 * "This answer is wrong": an employee's report on an answer, and the queue a
 * Knowledge Base module admin works it from.
 *
 * One open report per person per question (a unique partial index): reporting
 * again while the first is open updates it rather than adding a second. A
 * report is closed as resolved (something was wrong and was dealt with) or
 * dismissed (the answer was right), always with a note saying what was found;
 * the CHECK on kb_answer_reports holds the note and the time to the status.
 *
 * Filing and closing are both audited, in the same transaction as the change.
 */

export const KB_REPORT_COMMENT_MAX = 2_000;
export const KB_REPORT_NOTE_MAX = 2_000;

export class KbReportError extends Error {
  constructor(
    readonly code: "question_not_found" | "citation_not_found" | "report_not_found" | "already_closed",
    message: string,
  ) {
    super(message);
    this.name = "KbReportError";
  }
}

export type KbReportFiled = { id: string; questionId: string; reason: KbReportReason; status: KbReportStatus };

export async function reportAnswer(input: {
  questionId: string;
  reporterId: string;
  reason: KbReportReason;
  citationN?: number | null;
  comment?: string | null;
}): Promise<KbReportFiled> {
  const question = await prisma.kbQuestion.findUnique({ where: { id: input.questionId }, select: { answer: true } });
  if (!question) throw new KbReportError("question_not_found", "That answer no longer exists.");
  const citationN = input.citationN ?? null;
  const sources = (question.answer as unknown as KbAnswerSnapshot).sources ?? [];
  if (citationN !== null && !sources.some((s) => s.n === citationN)) {
    throw new KbReportError("citation_not_found", `The answer has no source [${citationN}].`);
  }
  const comment = input.comment?.trim() || null;

  return prisma.$transaction(async (tx) => {
    const open = await tx.kbAnswerReport.findFirst({
      where: { questionId: input.questionId, reportedById: input.reporterId, status: "open" },
      select: { id: true },
    });
    const report = open
      ? await tx.kbAnswerReport.update({ where: { id: open.id }, data: { reason: input.reason, citationN, comment } })
      : await tx.kbAnswerReport.create({
          data: { questionId: input.questionId, reportedById: input.reporterId, reason: input.reason, citationN, comment },
        });
    await writeAuditEvent(tx, {
      action: "kb.answer_reported",
      actorEmployeeId: input.reporterId,
      moduleKey: KNOWLEDGE_BASE_MODULE_KEY,
      metadata: { reportId: report.id, questionId: input.questionId, reason: input.reason, citationN, updated: Boolean(open) },
    });
    return { id: report.id, questionId: report.questionId, reason: report.reason as KbReportReason, status: report.status as KbReportStatus };
  });
}

export type KbReportView = {
  id: string;
  status: KbReportStatus;
  reason: KbReportReason;
  citationN: number | null;
  comment: string | null;
  reportedBy: string | null;
  createdAt: string;
  question: { id: string; conversationId: string; text: string; askedBy: string | null; answer: KbAnswerSnapshot };
  resolution: { by: string | null; note: string; at: string } | null;
};

const fullName = (e: { firstName: string; lastName: string } | null) => (e ? `${e.firstName} ${e.lastName}`.trim() : null);

/** The admin queue: open reports oldest first, or closed ones newest first. */
export async function listReports(status: "open" | "closed", limit = 100): Promise<KbReportView[]> {
  const rows = await prisma.kbAnswerReport.findMany({
    where: status === "open" ? { status: "open" } : { status: { in: ["resolved", "dismissed"] } },
    orderBy: status === "open" ? [{ createdAt: "asc" }, { id: "asc" }] : [{ resolvedAt: "desc" }, { id: "desc" }],
    take: limit,
    include: {
      reportedBy: { select: { firstName: true, lastName: true } },
      resolvedBy: { select: { firstName: true, lastName: true } },
      question: {
        select: {
          id: true,
          conversationId: true,
          question: true,
          answer: true,
          conversation: { select: { employee: { select: { firstName: true, lastName: true } } } },
        },
      },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    status: r.status as KbReportStatus,
    reason: r.reason as KbReportReason,
    citationN: r.citationN,
    comment: r.comment,
    reportedBy: fullName(r.reportedBy),
    createdAt: r.createdAt.toISOString(),
    question: {
      id: r.question.id,
      conversationId: r.question.conversationId,
      text: r.question.question,
      askedBy: fullName(r.question.conversation.employee),
      answer: r.question.answer as unknown as KbAnswerSnapshot,
    },
    resolution:
      r.status === "open" || !r.resolvedAt || !r.resolutionNote
        ? null
        : { by: fullName(r.resolvedBy), note: r.resolutionNote, at: r.resolvedAt.toISOString() },
  }));
}

export async function countOpenReports(): Promise<number> {
  return prisma.kbAnswerReport.count({ where: { status: "open" } });
}

/** Close an open report as resolved or dismissed, with a note. */
export async function closeReport(input: {
  reportId: string;
  adminId: string;
  status: "resolved" | "dismissed";
  note: string;
}): Promise<void> {
  const note = input.note.trim();
  await prisma.$transaction(async (tx) => {
    const report = await tx.kbAnswerReport.findUnique({ where: { id: input.reportId }, select: { status: true, questionId: true } });
    if (!report) throw new KbReportError("report_not_found", "That report no longer exists.");
    // Conditional on still being open, so two admins closing at once cannot both win.
    const closed = await tx.kbAnswerReport.updateMany({
      where: { id: input.reportId, status: "open" },
      data: { status: input.status, resolvedById: input.adminId, resolutionNote: note, resolvedAt: new Date() },
    });
    if (closed.count === 0) throw new KbReportError("already_closed", "Someone has already closed this report.");
    await writeAuditEvent(tx, {
      action: "kb.answer_report_closed",
      actorEmployeeId: input.adminId,
      moduleKey: KNOWLEDGE_BASE_MODULE_KEY,
      metadata: { reportId: input.reportId, questionId: report.questionId, status: input.status, note },
    });
  });
}

/** Which of these answers the viewer has an open report on, so the button can say so. */
export async function reportedByViewer(questionIds: string[], viewerId: string): Promise<Set<string>> {
  if (questionIds.length === 0) return new Set();
  const rows = await prisma.kbAnswerReport.findMany({
    where: { questionId: { in: questionIds }, reportedById: viewerId, status: "open" },
    select: { questionId: true },
  });
  return new Set(rows.map((r) => r.questionId));
}
