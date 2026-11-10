import { ok, withBas } from "@/lib/modules/bas/route-helpers";
import { reportsResult } from "@/lib/modules/bas/reports/http";
import { parseBody } from "@/lib/modules/bas/reports/parse";
import { createReport, listReports } from "@/lib/modules/bas/reports/service";
import { createReportSchema, type CreateReportInput } from "@/lib/validation/bas-reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/reports";

/**
 * The reports the viewer may see: their own, or every report for a module
 * admin. `withBas` - the BAS grant is the door; who may see WHICH report is
 * the service's decision, per row, and a report that is not theirs reads as
 * not existing.
 */
export async function GET() {
  return withBas(ROUTE, async (viewer) => ok(await listReports(viewer)));
}

/** Create a report, as a draft, owned by the caller. */
export async function POST(request: Request) {
  return withBas(
    ROUTE,
    async (viewer, input: CreateReportInput) =>
      reportsResult(
        () => createReport(viewer, input),
        (created) => ok(created, 201),
      ),
    parseBody(request, createReportSchema),
  );
}
