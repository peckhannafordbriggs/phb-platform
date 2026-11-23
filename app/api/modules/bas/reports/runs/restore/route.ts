import { ok, withBas } from "@/lib/modules/bas/route-helpers";
import { reportsResult } from "@/lib/modules/bas/reports/http";
import { parseBody } from "@/lib/modules/bas/reports/parse";
import { restoreRuns } from "@/lib/modules/bas/reports/runs-service";
import { runSelectionSchema } from "@/lib/validation/bas-reports";
import type { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/reports/runs/restore";

/**
 * Restore (2026-11-20): bring one run or a selection back from Recently
 * deleted, whole. Same people as Delete; all or nothing, 404 when one is not
 * in the viewer's Recently deleted. Retention never takes a restored run
 * again.
 */
export async function POST(request: Request) {
  return withBas(
    ROUTE,
    async (viewer, input: z.infer<typeof runSelectionSchema>) =>
      reportsResult(
        () => restoreRuns(viewer, input.runIds),
        (result) => ok(result),
      ),
    parseBody(request, runSelectionSchema),
  );
}
