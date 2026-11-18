import { ok, withBas } from "@/lib/modules/bas/route-helpers";
import { reportsResult } from "@/lib/modules/bas/reports/http";
import { removeReportRecipient } from "@/lib/modules/bas/reports/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/reports/[reportId]/recipients/[email]";

/**
 * Remove a recipient by address - the address is the row's natural key. The
 * owner's address is refused (409 owner_is_recipient) before any row is
 * looked for, so "remove the owner" is a refusal rather than a quiet
 * not-found: the owner is not a row, and could not be removed if one were.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ reportId: string; email: string }> },
) {
  return withBas(ROUTE, async (viewer) => {
    const { reportId, email } = await params;
    return reportsResult(
      () => removeReportRecipient(viewer, reportId, decodeURIComponent(email)),
      (result) => ok(result),
    );
  });
}
