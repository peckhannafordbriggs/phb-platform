import { notFound } from "next/navigation";
import { requireModuleAccess } from "@/lib/authz";
import { CHANGE_ORDERS_MODULE_KEY } from "@/lib/modules/change-orders/constants";

export const dynamic = "force-dynamic";

/**
 * The page is guarded server-side, exactly like the API route. Navigating
 * straight to /change-orders without a grant must not render the module, and
 * must not reveal that it exists - hence notFound() rather than a 403 screen.
 *
 * Placeholder content only. Phase 1 makes no Microsoft Graph calls.
 */
export default async function ChangeOrdersPage() {
  const access = await requireModuleAccess(CHANGE_ORDERS_MODULE_KEY);
  if (!access.ok) notFound();

  return (
    <div className="max-w-2xl">
      <h1 className="text-xl font-semibold">Change Orders</h1>
      <p className="mt-3 text-sm text-[var(--muted)]">
        The change-order workspace will live here. Mailbox access arrives in a
        later phase; Outlook remains a fully working path throughout.
      </p>
    </div>
  );
}
