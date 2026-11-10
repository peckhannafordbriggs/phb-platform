import { ok, withBas } from "@/lib/modules/bas/route-helpers";
import { reportsResult } from "@/lib/modules/bas/reports/http";
import { parseBody } from "@/lib/modules/bas/reports/parse";
import { changeReportState } from "@/lib/modules/bas/reports/service";
import { reportStateActionSchema } from "@/lib/validation/bas-reports";
import type { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/reports/[reportId]/state";

/**
 * activate, pause or resume. Activation computes the next run in the
 * building's zone and refuses a report with no questions or an unreadable
 * schedule; the transitions are the service's and a wrong one is 409.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ reportId: string }> },
) {
  return withBas(
    ROUTE,
    async (viewer, input: z.infer<typeof reportStateActionSchema>) => {
      const { reportId } = await params;
      return reportsResult(
        () => changeReportState(viewer, reportId, input.action),
        (result) => ok(result),
      );
    },
    parseBody(request, reportStateActionSchema),
  );
}
