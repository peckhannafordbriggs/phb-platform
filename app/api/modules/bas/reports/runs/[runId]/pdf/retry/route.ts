import { ok, withBas } from "@/lib/modules/bas/route-helpers";
import { reportsResult } from "@/lib/modules/bas/reports/http";
import { retryRunPdf } from "@/lib/modules/bas/reports/runs-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/reports/runs/[runId]/pdf/retry";

/**
 * Retry PDF (Phase 4): queue a failed render again, without re-running the
 * analysis. Owner or module admin, decided by the run's visibility rule;
 * a run whose PDF is not failed - ready, queued, or from before PDFs - is
 * 409 `pdf_not_retryable`. Answers 202: accepted, not done - the worker
 * does it, and the scaler counts the queued render so one starts.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  return withBas(ROUTE, async (viewer) => {
    const { runId } = await params;
    return reportsResult(
      () => retryRunPdf(viewer, runId),
      (result) => ok(result, 202),
    );
  });
}
