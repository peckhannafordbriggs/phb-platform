import { createVerificationSchema } from "@/lib/modules/freeze-protection/schemas";
import { createVerification } from "@/lib/modules/freeze-protection/verifications";
import { type IdParams, handleWrite } from "../../../handle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Starts a round. Status, exposure and protection carry forward from the newest earlier round. */
export async function POST(request: Request, { params }: IdParams) {
  const { id } = await params;
  return handleWrite(request, {
    route: "/api/modules/freeze-protection/projects/[id]/verifications",
    event: "fp.verification_create_failed",
    schema: createVerificationSchema,
    run: (actorId, body) => createVerification(actorId, id, body.verificationDate),
    status: 201,
  });
}
