import { notFound } from "next/navigation";
import { requireModuleAccess } from "@/lib/authz";
import { CHANGE_ORDERS_MODULE_KEY } from "@/lib/modules/change-orders/constants";
import { ModuleHeader } from "@/components/module-header";
import { MailboxWorkspace } from "./mailbox-workspace";

export const dynamic = "force-dynamic";

/**
 * The read-only Change Orders mailbox.
 *
 * Guarded server-side, exactly like every route it calls. Navigating straight to
 * /change-orders without a grant must not render the module and must not reveal
 * that it exists - hence notFound() rather than a 403 screen. Hiding the sidebar
 * item is not authorization; this is.
 *
 * The workspace is a client component because the panes are interactive and poll
 * while focused. It fetches through the module's own API routes, each of which
 * repeats this grant check independently.
 */
export default async function ChangeOrdersPage() {
  const access = await requireModuleAccess(CHANGE_ORDERS_MODULE_KEY);
  if (!access.ok) notFound();

  return (
    // Viewport-based rather than h-full: the shell's <main> has no definite
    // height of its own, and three independently scrolling panes need one.
    // 4rem is the shell's vertical padding.
    <div className="flex h-[calc(100vh-4rem)] min-h-0 flex-col">
      <div className="mb-4">
        <ModuleHeader
          moduleKey={CHANGE_ORDERS_MODULE_KEY}
          title="Change Orders"
          blurb="Reading changeorder@phb1899.com live. Outlook remains a fully working path and is unaffected by anything here."
        />
      </div>

      <div className="min-h-0 flex-1">
        <MailboxWorkspace />
      </div>
    </div>
  );
}
