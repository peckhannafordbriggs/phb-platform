import { signSchema } from "@/lib/modules/freeze-protection/schemas";
import { signVerification } from "@/lib/modules/freeze-protection/verifications";
import { type IdParams, handleWrite } from "../../../handle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Step 7. Signs, or removes a signature, as the signed-in employee. Self-review is 409. */
export async function POST(request: Request, { params }: IdParams) {
  const { id } = await params;
  return handleWrite(request, {
    route: "/api/modules/freeze-protection/verifications/[id]/signoff",
    event: "fp.verification_sign_failed",
    schema: signSchema,
    run: (actorId, body) => signVerification(actorId, id, body.role, body.signed),
  });
}
