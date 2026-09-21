import { redirect } from "next/navigation";
import { signOut } from "@/auth";
import { requireAuthenticated } from "@/lib/authz";
import { buildMe, type Me } from "@/lib/me";
import { Sidebar } from "./sidebar";

/**
 * The authenticated shell.
 *
 * This is also where the onboarding redirect lives. It cannot live in
 * middleware: middleware runs on the edge with no database, and the session
 * token deliberately carries no profileCompleted flag.
 */
export async function AppShell({
  children,
}: {
  children: React.ReactNode;
}) {
  /**
   * `recordActivity: false`, and this is the ONLY caller that passes it.
   *
   * The shell is the one component a `<Link>` prefetch can reach: a prefetch
   * of a dynamic route renders nothing unless a `loading.tsx` sits below it,
   * and `/admin` and `/admin/audit` have one, so hovering the Admin link
   * renders this shell and stops before the page. Hovering is not being here.
   * The page beneath calls its own guard, and that call records - see the
   * activity note in lib/authz/guard.ts.
   */
  const access = await requireAuthenticated({ recordActivity: false });

  if (!access.ok) {
    if (access.denial === "employee_inactive") redirect("/unauthorized");
    redirect("/signin");
  }

  if (!access.viewer.profileCompleted) {
    redirect("/onboarding");
  }

  const me: Me = await buildMe(access.viewer);

  async function signOutAction(): Promise<void> {
    "use server";
    await signOut({ redirectTo: "/signin" });
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar
        modules={me.modules}
        isPlatformAdmin={me.isPlatformAdmin}
        employeeName={`${me.employee.firstName} ${me.employee.lastName}`.trim()}
        employeeEmail={me.employee.email}
        signOutAction={signOutAction}
      />
      <main className="min-w-0 flex-1 px-8 py-8">{children}</main>
    </div>
  );
}
