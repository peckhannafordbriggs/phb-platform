import { ok, withBas } from "@/lib/modules/bas/route-helpers";
import { reportsResult } from "@/lib/modules/bas/reports/http";
import { resendFailedDeliveries } from "@/lib/modules/bas/reports/runs-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/reports/runs/[runId]/deliveries/resend";

/**
 * Resend (Reports, Phase 4, the email half): queue the run's FAILED email
 * deliveries again, and nothing else. Owner or module admin, by the run's
 * visibility rule; 409 `nothing_to_resend` when none has failed. Audited.
 * Answers 202: the worker sends, not this route - the web app never sends.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  return withBas(ROUTE, async (viewer) => {
    const { runId } = await params;
    return reportsResult(
      () => resendFailedDeliveries(viewer, runId),
      (result) => ok(result, 202),
    );
  });
}
