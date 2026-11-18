import { History, Tags } from "lucide-react";
import { ModuleHeader } from "@/components/module-header";
import { Button, TabBar } from "@/components/ui";
import type { InviteEmail } from "@/lib/admin/invite-email";
import { InviteEmailButton } from "./invite-email-button";

/**
 * The chrome of the Admin Employees screen, on the module shells' shape
 * (2026-11-13): the tinted ground, the header with its diamond and hairline,
 * one tab row with the actions at its right - Cost Intelligence's header row.
 *
 * A component rather than a layout, for the reason every module shell gives:
 * a layout renders around a page that calls `notFound()`, and the page's own
 * guard decides who sees this.
 *
 * Admin is not a module. It has no key in lib/module-accent.ts and no colour
 * of its own, so the header wears the chrome purple by name (`accent`) rather
 * than whatever the lookup hands an unknown key; the sidebar draws the Admin
 * section in the chrome's colours for the same reason.
 *
 * The audit log and the lists keep their own pages and their own chrome;
 * this shell is the Employees screen's, and the two buttons are the way
 * there.
 */
export function AdminShell({
  actions,
  children,
}: {
  /** Right-aligned controls on the tab row. */
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="dashboard-ground -mx-8 -my-8 px-8 py-8">
      <div className="mx-auto max-w-[104rem]">
        <ModuleHeader
          moduleKey="admin"
          accent="var(--accent)"
          title="Admin"
          blurb="Everyone who has ever signed in appears here. Granting a module is what gives access; there is no way to create an employee."
        >
          <TabBar label="Admin sections" tabs={[{ href: "/admin", label: "Employees", active: true }]} actions={actions} />
        </ModuleHeader>

        <div className="mt-6">{children}</div>
      </div>
    </div>
  );
}

/**
 * The three header actions. Copy invite email is the one that does something
 * here; the other two are the way to the audit log and to the positions and
 * departments lists, which keep their own pages.
 */
export function AdminActions({ email }: { email: InviteEmail }) {
  return (
    <>
      <InviteEmailButton email={email} />
      <Button href="/admin/audit">
        <History size={16} aria-hidden="true" />
        Audit log
      </Button>
      <Button href="/admin/lists">
        <Tags size={16} aria-hidden="true" />
        Positions &amp; departments
      </Button>
    </>
  );
}
