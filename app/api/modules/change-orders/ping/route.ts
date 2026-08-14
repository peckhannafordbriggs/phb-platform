import { denialResponse, requireModuleAccess } from "@/lib/authz";
import { ok } from "@/lib/api/response";
import { CHANGE_ORDERS_MODULE_KEY } from "@/lib/modules/change-orders/constants";

// Prisma needs Node, and every route under app/api/modules/* is database-backed.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Exists solely to prove the guard works. It touches nothing, reads nothing,
 * and makes no Microsoft Graph call - Phase 1 makes none anywhere.
 */
export async function GET() {
  const access = await requireModuleAccess(CHANGE_ORDERS_MODULE_KEY);
  if (!access.ok) return denialResponse(access.denial);

  return ok({ ok: true });
}
