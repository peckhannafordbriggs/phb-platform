import { signProject } from "@/lib/modules/freeze-protection/projects";
import { signSchema } from "@/lib/modules/freeze-protection/schemas";
import { type IdParams, handleWrite } from "../../../handle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Step 7. Signs, or removes a signature, as the signed-in employee. Self-review is 409. */
export async function POST(request: Request, { params }: IdParams) {
  const { id } = await params;
  return handleWrite(request, {
    route: "/api/modules/freeze-protection/projects/[id]/signoff",
    event: "fp.project_sign_failed",
    schema: signSchema,
    run: (actorId, body) => signProject(actorId, id, body.role, body.signed),
  });
}
