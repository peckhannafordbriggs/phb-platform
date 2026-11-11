import { ok, withBas } from "@/lib/modules/bas/route-helpers";
import { reportsResult } from "@/lib/modules/bas/reports/http";
import { parseBody } from "@/lib/modules/bas/reports/parse";
import { transferReportOwner } from "@/lib/modules/bas/reports/service";
import { transferOwnerSchema, type TransferOwnerInput } from "@/lib/validation/bas-reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/reports/[reportId]/owner";

/**
 * Transfer the report to another owner (Phase 3). Module admin only - an
 * owner without the flag is 403 `admin_required`, and anyone who may not
 * see the report is 404 as everywhere. A report the scheduler paused
 * because its owner was disabled is resumed by this.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ reportId: string }> },
) {
  return withBas(
    ROUTE,
    async (viewer, input: TransferOwnerInput) => {
      const { reportId } = await params;
      return reportsResult(
        () => transferReportOwner(viewer, reportId, input),
        (result) => ok(result),
      );
    },
    parseBody(request, transferOwnerSchema),
  );
}
