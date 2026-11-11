import { z } from "zod";
import { denialResponse, requireModuleAccess } from "@/lib/authz";
import { notFound, ok, serverError } from "@/lib/api/response";
import { logUnexpected } from "@/lib/logger";
import { getConversation } from "@/lib/modules/knowledge-base/ask";
import { KNOWLEDGE_BASE_MODULE_KEY } from "@/lib/modules/knowledge-base/constants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type IdParams = { params: Promise<{ id: string }> };

/**
 * GET /api/modules/knowledge-base/history/<conversation id>
 *
 * One conversation, every question and answer in order, with `mine` saying
 * whether the viewer may add a follow-up. Anyone with the grant; 404 for an
 * unknown id or no grant.
 */
export async function GET(_request: Request, { params }: IdParams) {
  const access = await requireModuleAccess(KNOWLEDGE_BASE_MODULE_KEY);
  if (!access.ok) return denialResponse(access.denial);
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return notFound();
  try {
    const conversation = await getConversation(id, access.viewer.id);
    return conversation ? ok(conversation) : notFound();
  } catch (error) {
    logUnexpected("kb.conversation_failed", error, { employeeId: access.viewer.id });
    return serverError();
  }
}
