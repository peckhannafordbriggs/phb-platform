import { denialResponse, requireAuthenticated } from "@/lib/authz";
import { ok } from "@/lib/api/response";
import { buildMe } from "@/lib/me";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Uses requireAuthenticated, not requireEmployee: the onboarding screen needs
 * this before the profile is complete. profileCompleted is in the payload so
 * the caller can tell the difference.
 */
export async function GET() {
  const access = await requireAuthenticated();
  if (!access.ok) return denialResponse(access.denial);

  return ok(await buildMe(access.viewer));
}
