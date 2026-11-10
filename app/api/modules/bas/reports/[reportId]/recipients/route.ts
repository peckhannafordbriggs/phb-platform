import { ok, withBas } from "@/lib/modules/bas/route-helpers";
import { reportsResult } from "@/lib/modules/bas/reports/http";
import { parseBody } from "@/lib/modules/bas/reports/parse";
import { addReportRecipient } from "@/lib/modules/bas/reports/service";
import { addRecipientSchema, type AddRecipientInput } from "@/lib/validation/bas-reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/reports/[reportId]/recipients";

/**
 * Add an ADDITIONAL recipient. The owner's own address is refused (409
 * owner_is_recipient): the owner is always a recipient and never a row. An
 * address outside the company is refused until the body carries
 * `confirmed: true` (409 external_unconfirmed), and is then stored and
 * audited as external.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ reportId: string }> },
) {
  return withBas(
    ROUTE,
    async (viewer, input: AddRecipientInput) => {
      const { reportId } = await params;
      return reportsResult(
        () => addReportRecipient(viewer, reportId, input),
        (created) => ok(created, 201),
      );
    },
    parseBody(request, addRecipientSchema),
  );
}
