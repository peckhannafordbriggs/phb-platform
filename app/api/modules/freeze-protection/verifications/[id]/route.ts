import { denialResponse, requireModuleAccess } from "@/lib/authz";
import { notFound, ok } from "@/lib/api/response";
import { FREEZE_PROTECTION_MODULE_KEY } from "@/lib/modules/freeze-protection/constants";
import { updateVerificationSchema } from "@/lib/modules/freeze-protection/schemas";
import {
  deleteVerification,
  getRegister,
  getVerification,
  updateVerification,
} from "@/lib/modules/freeze-protection/verifications";
import { type IdParams, handleWrite } from "../../handle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/freeze-protection/verifications/[id]";

/** The round and its register. */
export async function GET(_request: Request, { params }: IdParams) {
  const access = await requireModuleAccess(FREEZE_PROTECTION_MODULE_KEY);
  if (!access.ok) return denialResponse(access.denial);
  const { id } = await params;
  const verification = await getVerification(id);
  if (verification === null) return notFound("Verification not found.");
  return ok({ verification, lines: await getRegister(id) });
}

export async function PATCH(request: Request, { params }: IdParams) {
  const { id } = await params;
  return handleWrite(request, {
    route: ROUTE,
    event: "fp.verification_update_failed",
    schema: updateVerificationSchema,
    run: (actorId, body) => updateVerification(actorId, id, body),
  });
}

export async function DELETE(request: Request, { params }: IdParams) {
  const { id } = await params;
  return handleWrite(request, {
    route: ROUTE,
    event: "fp.verification_delete_failed",
    schema: null,
    run: (actorId) => deleteVerification(actorId, id),
  });
}
