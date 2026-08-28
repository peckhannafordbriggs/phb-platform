"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { MeModule } from "@/lib/me";

/**
 * The sidebar is the constant, so it carries the brand and the rest does not.
 *
 * The SYSTEMS section is rendered entirely from the modules passed in, which
 * come from the employee's actual grants. There is no hardcoded module list
 * here - adding a row to the modules table is what makes an item appear.
 *
 * Hiding an item is not authorization. Every route behind these links is
 * independently guarded server-side.
 */

/**
 * The quadrant colours, in the order the mark reads them.
 *
 * A module's colour comes from its POSITION in the granted list, never from its
 * key - CLAUDE.md keys authorization on the stable `key` and the design brief
 * forbids naming a module in the UI, so a lookup table of key-to-colour would
 * break both. With the seeded sortOrder (Change Orders 100, BAS 200) this gives
 * Change Orders red and BAS cyan, which is what the brief specifies.
 *
 * The honest cost: reordering the modules table reassigns the colours. That is
 * acceptable because the colour's job is "which system am I in", which is
 * answered by consistency across one session rather than permanence across
 * years - and because the alternative is a component that knows module keys.
 */
const QUADRANT_ACCENTS = [
  "var(--phb-red)",
  "var(--phb-cyan)",
  "var(--phb-orange)",
  "var(--phb-teal)",
  "var(--phb-pink)",
] as const;

export function moduleAccent(index: number): string {
  return QUADRANT_ACCENTS[index % QUADRANT_ACCENTS.length] ?? "var(--phb-red)";
}

/**
 * Shared by the two footer actions so they cannot drift apart.
 *
 * `inline-flex` with a fixed height rather than relying on the text's own line
 * box: a button and an anchor compute line-height differently, which is what put
 * them on different baselines. `font-inherit` matters too - a button does not
 * inherit the page font on its own.
 */
const FOOTER_ACTION =
  "inline-flex h-5 items-center font-[family-name:var(--font-ui)] text-xs " +
  "underline underline-offset-2 transition-colors hover:text-white";

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
    <nav className="chrome flex w-60 shrink-0 flex-col bg-[var(--chrome)] text-[var(--chrome-text)]">
      <div className="px-5 pb-3 pt-5">
        <Link href="/" className="flex items-center gap-2.5">
          {/*
            The real mark, small. It is intricate and turns to mud much below
            this, which is why the diamond used elsewhere is the SHAPE rather
            than a scaled-down copy of the logo.
          */}
          <Image
            src="/phb-logo.png"
            alt=""
            width={30}
            height={30}
            priority
            className="shrink-0"
          />
          <span className="font-[family-name:var(--font-display)] text-[0.8125rem] font-semibold uppercase leading-[1.15] tracking-[0.02em]">
            Peck Hannaford
            <br />
            <span className="text-[var(--chrome-muted)]">+ Briggs</span>
          </span>
        </Link>
      </div>

      {/*
        THE ONE DIAGONAL. Four skewed segments in the four quadrant colours,
        directly under the logo block. The entire identity sits on the 45deg
        diagonal, so it is spent here - in the chrome, where no data lives - and
        nowhere else in the platform.
      */}
      <div className="quad-band mx-5 mb-5" aria-hidden="true">
        <span style={{ background: "var(--phb-red)" }} />
        <span style={{ background: "var(--phb-orange)" }} />
        <span style={{ background: "var(--phb-cyan)" }} />
        <span style={{ background: "var(--phb-teal)" }} />
      </div>

      <div className="px-3">
        <SectionLabel>Home</SectionLabel>
        <SidebarLink href="/" label="Home" active={pathname === "/"} />
      </div>

      {modules.length > 0 && (
        <div className="mt-6 px-3">
          <SectionLabel>Systems</SectionLabel>
          {modules.map((module, index) => {
            const href = `/${module.key}`;
            return (
              <SidebarLink
                key={module.key}
                href={href}
                label={module.displayName}
                accent={moduleAccent(index)}
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
            label="Employees"
            active={
              pathname === "/admin" ||
              (pathname.startsWith("/admin/") && !pathname.startsWith("/admin/audit"))
            }
          />
          <SidebarLink
            href="/admin/audit"
            label="Audit log"
            active={pathname.startsWith("/admin/audit")}
          />
        </div>
      )}

      <div className="mt-auto border-t border-white/15 px-5 py-4">
        <p className="truncate text-sm font-medium">{employeeName}</p>
        {/*
          Mono for the address. It is an identifier rather than prose, and the
          same reasoning puts message ids and point names in mono.
        */}
        <p className="truncate font-[family-name:var(--font-mono)] text-[0.6875rem] text-[var(--chrome-muted)]">
          {employeeEmail}
        </p>
        {/*
          Profile is a Link and Sign out is a submit button inside a form, which
          is not negotiable - signing out is a POST through a server action.
          Left alone they sit on different baselines: the button carries the UA's
          default font and line-height, and the form is a block box the flex row
          aligns rather than the button inside it.

          Fixed by making both leaf elements identical boxes - same class, same
          font, `inline-flex` with a fixed height so the text centres on the same
          line - and by making the form `contents`, so it contributes no box of
          its own and the button becomes a direct flex child alongside the link.
        */}
        <div className="mt-3 flex items-center gap-3">
          <Link
            href="/profile"
            aria-current={pathname === "/profile" ? "page" : undefined}
            className={
              FOOTER_ACTION +
              (pathname === "/profile"
                ? " font-medium text-white"
                : " text-[var(--chrome-muted)]")
            }
          >
            Profile
          </Link>
          <form action={signOutAction} className="contents">
            <button
              type="submit"
              className={FOOTER_ACTION + " text-[var(--chrome-muted)]"}
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
    <p className="eyebrow flex items-center gap-1.5 px-2 pb-1.5 text-[var(--chrome-muted)]">
      <span className="diamond h-[0.3125rem] w-[0.3125rem]" aria-hidden="true" />
      {children}
    </p>
  );
}

function SidebarLink({
  href,
  label,
  active,
  accent,
}: {
  href: string;
  label: string;
  active: boolean;
  /** A module's quadrant colour. Absent for Home and Admin, which are chrome. */
  accent?: string;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={
        "flex items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors " +
        (active ? "bg-white/12 font-medium text-white" : "text-white/80 hover:bg-white/8")
      }
    >
      {accent !== undefined && (
        /*
          Filled in the module's colour when active, hollow when not. Never the
          only signal - the row is also highlighted and carries aria-current, so
          nothing here encodes meaning in colour alone.
        */
        <span
          className={"diamond" + (active ? " diamond--filled" : "")}
          style={{ color: accent }}
          aria-hidden="true"
        />
      )}
      <span className="truncate">{label}</span>
    </Link>
  );
}
