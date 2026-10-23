import { ok } from "@/lib/api/response";
import { withReview } from "@/lib/modules/change-orders/review/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/change-orders/review/count";

/**
 * The number on the tab, and the date beside it. One folder listing, no note
 * read: this is what the tab bar polls while a Change Orders screen is open.
 */
export async function GET() {
  return withReview(ROUTE, async (service) => ok(await service.summary()));
}
