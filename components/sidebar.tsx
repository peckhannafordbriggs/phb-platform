"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { MeModule } from "@/lib/me";

/**
 * The SYSTEMS section is rendered entirely from the modules passed in, which
 * come from the employee's actual grants. There is no hardcoded module list
 * here - adding a row to the modules table is what makes an item appear.
 *
 * Hiding an item is not authorization. Every route behind these links is
 * independently guarded server-side.
 */
export function Sidebar({
  modules,
  isPlatformAdmin,
  employeeName,
  employeeEmail,
  signOutAction,
}: {
  modules: MeModule[];
  isPlatformAdmin: boolean;
  employeeName: string;
  employeeEmail: string;
  signOutAction: () => Promise<void>;
}) {
  const pathname = usePathname();

  return (
    <nav className="flex w-60 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface)]">
      <div className="px-5 py-5">
        <Link href="/" className="text-base font-semibold tracking-tight">
          PHB
        </Link>
      </div>

      <div className="px-3">
        <SidebarLink href="/" label="Home" active={pathname === "/"} />
      </div>

      {modules.length > 0 && (
        <div className="mt-6 px-3">
          <SectionLabel>Systems</SectionLabel>
          {modules.map((module) => {
            const href = `/${module.key}`;
            return (
              <SidebarLink
                key={module.key}
                href={href}
                label={module.displayName}
                active={pathname === href || pathname.startsWith(`${href}/`)}
              />
            );
          })}
        </div>
      )}

      {isPlatformAdmin && (
        <div className="mt-6 px-3">
          <SectionLabel>Admin</SectionLabel>
          <SidebarLink
            href="/admin"
            label="Admin"
            active={pathname.startsWith("/admin")}
          />
        </div>
      )}

      <div className="mt-auto border-t border-[var(--border)] px-5 py-4">
        <p className="truncate text-sm font-medium">{employeeName}</p>
        <p className="truncate text-xs text-[var(--muted)]">{employeeEmail}</p>
        <div className="mt-3 flex items-center gap-3">
          <Link
            href="/profile"
            aria-current={pathname === "/profile" ? "page" : undefined}
            className={
              "text-xs underline underline-offset-2 hover:text-[var(--foreground)] " +
              (pathname === "/profile"
                ? "font-medium text-[var(--accent)]"
                : "text-[var(--muted)]")
            }
          >
            Profile
          </Link>
          <form action={signOutAction}>
            <button
              type="submit"
              className="text-xs text-[var(--muted)] underline underline-offset-2 hover:text-[var(--foreground)]"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>
    </nav>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-2 pb-1 text-[0.6875rem] font-semibold uppercase tracking-wider text-[var(--muted)]">
      {children}
    </p>
  );
}

function SidebarLink({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={
        "block rounded px-2 py-1.5 text-sm " +
        (active
          ? "bg-white font-medium text-[var(--accent)] shadow-sm"
          : "text-[var(--foreground)] hover:bg-white/70")
      }
    >
      {label}
    </Link>
  );
}
