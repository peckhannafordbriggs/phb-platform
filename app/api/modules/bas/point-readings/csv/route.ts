import { NextResponse } from "next/server";
import { fail } from "@/lib/api/response";
import { BasError } from "@/lib/modules/bas/errors";
import {
  CAP_HEADER,
  EXPORTED_HEADER,
  TOTAL_HEADER,
  exportPointReadings,
  parseReadingsQuery,
  type ReadingsRequest,
} from "@/lib/modules/bas/readings";
import { withBas } from "@/lib/modules/bas/route-helpers";

// Prisma needs Node, and every route under app/api/modules/* is database-backed.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/point-readings/csv";

/**
 * Every raw reading in the chart's range, as CSV, streamed.
 *
 * The same `point` / `from` / `to` as the JSON route and no `page`: the file
 * is every page. The body is produced as it is read, one keyset chunk per
 * query (lib/modules/bas/readings.ts), so a 500,000-row export is never held
 * on the server at once. Once the headers have gone a failure mid-stream can
 * only abort the download; the count, the point and the entitlement are all
 * settled before that, which is where every refusal below comes from.
 */
export async function GET(request: Request) {
  return withBas(
    ROUTE,
    async (viewer, input: ReadingsRequest) => {
      let exportJob;
      try {
        exportJob = await exportPointReadings(viewer, input);
      } catch (error) {
        if (error instanceof BasError && error.code === "point_not_found") {
          return fail(404, "not_found", error.message);
        }
        if (error instanceof BasError && error.code === "invalid_range") {
          return fail(422, "validation_failed", error.message);
        }
        throw error;
      }

      const encoder = new TextEncoder();
      const iterator = exportJob.chunks();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await iterator.next();
            if (next.done) controller.close();
            else controller.enqueue(encoder.encode(next.value));
          } catch (error) {
            controller.error(error);
          }
        },
        async cancel() {
          await iterator.return(undefined);
        },
      });

      return new NextResponse(body, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${exportJob.filename}"`,
          "Cache-Control": "no-store",
          [TOTAL_HEADER]: String(exportJob.total),
          [EXPORTED_HEADER]: String(exportJob.exported),
          [CAP_HEADER]: String(exportJob.cap),
        },
      });
    },
    async () => parseReadingsQuery(new URL(request.url).searchParams, { page: false }),
  );
}
