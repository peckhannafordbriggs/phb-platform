import { ok, withBas } from "@/lib/modules/bas/route-helpers";
import { reportsResult } from "@/lib/modules/bas/reports/http";
import { sendRunToMe } from "@/lib/modules/bas/reports/runs-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/reports/runs/[runId]/deliveries/send-to-me";

/**
 * Send to me (Reports, Phase 4, the email half): queue one copy of a
 * finished run to the signed-in person's own address - taken from the
 * session, never from the request. Owner or module admin; 409
 * `run_not_sendable` for a run with no finished report, 409
 * `delivery_pending` while a copy to them is already waiting. Audited.
 * Answers 202: the worker sends it.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  return withBas(ROUTE, async (viewer) => {
    const { runId } = await params;
    return reportsResult(
      () => sendRunToMe(viewer, runId),
      (result) => ok(result, 202),
    );
  });
}
