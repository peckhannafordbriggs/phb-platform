import { ok } from "@/lib/api/response";
import { withReview } from "@/lib/modules/change-orders/review/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/change-orders/review";

/**
 * Every note in `_needs_review`, read and grouped by subject, with the count
 * and the oldest date. GET only; the folder is never written - see the
 * service.
 */
export async function GET() {
  return withReview(ROUTE, async (service) => ok(await service.listNotes()));
}
