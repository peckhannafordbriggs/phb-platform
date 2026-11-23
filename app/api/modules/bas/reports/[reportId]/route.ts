import { ok, withBas } from "@/lib/modules/bas/route-helpers";
import { reportsResult } from "@/lib/modules/bas/reports/http";
import { parseReportBody } from "@/lib/modules/bas/reports/parse";
import { deleteReport, getReport, updateReport } from "@/lib/modules/bas/reports/service";
import { updateReportSchema, type UpdateReportInput } from "@/lib/validation/bas-reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/reports/[reportId]";

/**
 * One report, with its questions, stations and recipients. Owner or module
 * admin; anyone else is answered 404, the same as for a report that does not
 * exist, so the existence of somebody else's report is not confirmed.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ reportId: string }> },
) {
  return withBas(ROUTE, async (viewer) => {
    const { reportId } = await params;
    return reportsResult(
      () => getReport(viewer, reportId),
      (report) => ok(report),
    );
  });
}

/**
 * Edit details, building, stations, window, schedule, the questions (the
 * whole selection) and the preset label. The two removed per-report limits
 * are refused with 400 (`parseReportBody`).
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ reportId: string }> },
) {
  return withBas(
    ROUTE,
    async (viewer, input: UpdateReportInput) => {
      const { reportId } = await params;
      return reportsResult(
        () => updateReport(viewer, reportId, input),
        (result) => ok(result),
      );
    },
    parseReportBody(request, updateReportSchema),
  );
}

/**
 * Delete a report (2026-11-20): future runs stop and it leaves every
 * Scheduled list; its generated runs stay on the Reports list, "(schedule
 * deleted)". 409 run_in_flight while one of its runs is queued or running.
 * Answers how many runs were kept.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ reportId: string }> },
) {
  return withBas(ROUTE, async (viewer) => {
    const { reportId } = await params;
    return reportsResult(
      () => deleteReport(viewer, reportId),
      (result) => ok(result),
    );
  });
}
