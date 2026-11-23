import { ok, withBas } from "@/lib/modules/bas/route-helpers";
import { reportsResult } from "@/lib/modules/bas/reports/http";
import { parseBody } from "@/lib/modules/bas/reports/parse";
import { deleteRuns } from "@/lib/modules/bas/reports/runs-service";
import { runSelectionSchema } from "@/lib/validation/bas-reports";
import type { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/reports/runs/delete";

/**
 * Delete (2026-11-20): move one run or a selection to Recently deleted,
 * where it can be restored for 15 days. The report's owner or a module
 * admin; all or nothing - a run the viewer cannot see, or one already
 * deleted, is 404 for the whole selection, and a run still queued or
 * running is 409 `run_not_finished`. Not audited: the owner's own data.
 */
export async function POST(request: Request) {
  return withBas(
    ROUTE,
    async (viewer, input: z.infer<typeof runSelectionSchema>) =>
      reportsResult(
        () => deleteRuns(viewer, input.runIds),
        (result) => ok(result),
      ),
    parseBody(request, runSelectionSchema),
  );
}
