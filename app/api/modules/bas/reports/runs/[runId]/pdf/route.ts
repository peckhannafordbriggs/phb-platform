import { NextResponse } from "next/server";
import { withBas } from "@/lib/modules/bas/route-helpers";
import { reportsResult } from "@/lib/modules/bas/reports/http";
import { contentDisposition } from "@/lib/modules/bas/reports/pdf/naming";
import { loadRunPdf } from "@/lib/modules/bas/reports/runs-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/reports/runs/[runId]/pdf";

/**
 * The run's PDF as a download (Phase 4). Guarded exactly as viewing the run
 * is: the report's owner or a module admin; anyone else is answered 404 by
 * the same visibility rule. A visible run with no PDF is 409
 * `pdf_not_available`, saying why - queued, failed, or from before PDFs.
 *
 * `Content-Disposition` names the file "<report name> <period>.pdf"; the
 * bytes are the stored column, read by this one service call and nowhere
 * else. No caching: the file is private to the viewer.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  return withBas(ROUTE, async (viewer) => {
    const { runId } = await params;
    return reportsResult(
      () => loadRunPdf(viewer, runId),
      (file) =>
        new NextResponse(new Uint8Array(file.bytes), {
          status: 200,
          headers: {
            "Content-Type": "application/pdf",
            "Content-Length": String(file.bytes.length),
            "Content-Disposition": contentDisposition(file.fileName),
            "Cache-Control": "private, no-store",
          },
        }),
    );
  });
}
