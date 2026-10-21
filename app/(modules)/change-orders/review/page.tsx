import { notFound } from "next/navigation";
import { requireModuleAccess } from "@/lib/authz";
import { CHANGE_ORDERS_MODULE_KEY } from "@/lib/modules/change-orders/constants";
import { CoShell } from "../co-shell";
import { REVIEW_TAB_HREF, coTab } from "../tabs";
import { ReviewWorkspace } from "../review-workspace";

export const dynamic = "force-dynamic";

/**
 * Needs Review - the second Change Orders tab (2026-10-21).
 *
 * Guarded here, on this route, by the same module grant the mailbox uses, and
 * not by the tab bar. Navigating straight here without a grant must not render
 * the module and must not reveal that it exists - hence notFound() rather than
 * a 403. Every API route the workspace calls repeats the check.
 */
export default async function NeedsReviewPage() {
  const access = await requireModuleAccess(CHANGE_ORDERS_MODULE_KEY);
  if (!access.ok) notFound();

  return (
    <div className="flex h-[calc(100vh-4rem)] min-h-0 flex-col">
      <div className="mb-4">
        <CoShell blurb={coTab(REVIEW_TAB_HREF).blurb} />
      </div>

      <div className="min-h-0 flex-1">
        <ReviewWorkspace />
      </div>
    </div>
  );
}
