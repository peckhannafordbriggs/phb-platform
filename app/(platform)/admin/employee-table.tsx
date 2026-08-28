"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { BulkBar } from "./bulk-bar";

export interface AdminEmployeeRow {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  positionOther: string | null;
  profileCompleted: boolean;
  status: "active" | "disabled";
  isPlatformAdmin: boolean;
  lastLoginAt: Date | string | null;
  position: { id: string; name: string } | null;
  department: { id: string; name: string } | null;
  grantedModuleKeys: string[];
}

export function EmployeeTable({
  employees,
  modules,
  page,
  pageSize,
  total,
  employeesTotal,
  totalPages,
  sort,
  dir,
  filtered,
}: {
  employees: AdminEmployeeRow[];
  modules: { key: string; displayName: string }[];
  page: number;
  pageSize: number;
  total: number;
  /** Every employee, before any filter. Distinguishes the two empty states. */
  employeesTotal: number;
  totalPages: number;
  sort: "name" | "lastLogin" | "status";
  dir: "asc" | "desc";
  filtered: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [selected, setSelected] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) =>
      prev.size === employees.length
        ? new Set()
        : new Set(employees.map((e) => e.id)),
    );
  }

  function pageHref(target: number): string {
    const params = new URLSearchParams(searchParams.toString());
    params.set("page", String(target));
    return `/admin?${params.toString()}`;
  }

  /**
   * A sort link for one column.
   *
   * Clicking the active column flips direction; clicking another switches to it
   * in its natural direction - ascending for a name, descending for a date,
   * since "most recent first" is what somebody wants from a last-sign-in column
   * and "A first" is what they want from a name.
   *
   * Always returns to page 1: staying on page 4 of a differently ordered list
   * shows a slice nobody asked for.
   */
  function sortHref(column: "name" | "lastLogin" | "status"): string {
    const params = new URLSearchParams(searchParams.toString());
    const natural = column === "lastLogin" ? "desc" : "asc";
    params.set("sort", column);
    params.set("dir", sort === column ? (dir === "asc" ? "desc" : "asc") : natural);
    params.set("page", "1");
    return `/admin?${params.toString()}`;
  }

  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <div className="mt-6">
      <BulkBar
        selectedIds={[...selected]}
        modules={modules}
        onClear={() => setSelected(new Set())}
        onDone={() => {
          setSelected(new Set());
          router.refresh();
        }}
      />

      <p className="mb-2 text-sm text-[var(--muted)]">
        {total === 0 ? "No employees" : `${total} ${total === 1 ? "employee" : "employees"}`}
        {filtered && (
          <>
            {" "}
            matching the current filters
            {total !== employeesTotal && ` · ${employeesTotal} in total`}
          </>
        )}
      </p>

      <div className="overflow-x-auto rounded border border-[var(--border)]">
        <table className="w-full min-w-[54rem] border-collapse text-sm">
          <thead className="bg-[var(--surface)] text-left">
            <tr>
              <th className="w-10 px-3 py-2">
                <input
                  type="checkbox"
                  aria-label="Select all on this page"
                  checked={
                    employees.length > 0 && selected.size === employees.length
                  }
                  onChange={toggleAll}
                />
              </th>
              <SortableTh column="name" active={sort} dir={dir} href={sortHref("name")}>
                Name
              </SortableTh>
              <Th>Email</Th>
              <Th>
                Position{" "}
                <span className="font-normal italic text-[var(--muted)]">
                  self-reported
                </span>
              </Th>
              <Th>Department</Th>
              <SortableTh column="status" active={sort} dir={dir} href={sortHref("status")}>
                Status
              </SortableTh>
              <SortableTh
                column="lastLogin"
                active={sort}
                dir={dir}
                href={sortHref("lastLogin")}
              >
                Last sign-in
              </SortableTh>
              {modules.map((m) => (
                <Th key={m.key}>{m.displayName}</Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {employees.length === 0 && (
              <tr>
                <td
                  colSpan={7 + modules.length}
                  className="px-3 py-10 text-center text-[var(--muted)]"
                >
                  {/*
                    PHASE-10: "no results from a filter reads differently from no
                    employees at all". They call for different actions - one is
                    "widen the filter", the other is "nobody has signed in yet" -
                    and a single message would send an admin looking for a
                    filter to clear on a platform that has no rows to show.
                  */}
                  {employeesTotal === 0 ? (
                    <>
                      <span className="block font-medium text-[var(--foreground)]">
                        Nobody has signed in yet
                      </span>
                      <span className="mt-1 block text-sm">
                        Employees appear here the first time they sign in. There
                        is no way to create one.
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="block font-medium text-[var(--foreground)]">
                        No employees match these filters
                      </span>
                      <span className="mt-1 block text-sm">
                        {employeesTotal} {employeesTotal === 1 ? "employee" : "employees"}{" "}
                        exist in total.{" "}
                        <Link href="/admin?scope=all" className="underline underline-offset-2">
                          Show everyone
                        </Link>
                        .
                      </span>
                    </>
                  )}
                </td>
              </tr>
            )}

            {employees.map((employee) => (
              <tr
                key={employee.id}
                className="border-t border-[var(--border)] align-middle"
              >
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label={`Select ${employee.email}`}
                    checked={selected.has(employee.id)}
                    onChange={() => toggle(employee.id)}
                  />
                </td>
                <td className="px-3 py-2">
                  <Link
                    href={`/admin/${employee.id}`}
                    className="text-[var(--accent)] underline underline-offset-2"
                  >
                    {employee.firstName} {employee.lastName}
                  </Link>
                  {employee.isPlatformAdmin && (
                    <span className="ml-2 rounded bg-[var(--accent)] px-1.5 py-0.5 text-[0.625rem] font-medium uppercase text-white">
                      Admin
                    </span>
                  )}
                  {!employee.profileCompleted && (
                    <span className="ml-2 text-xs italic text-[var(--muted)]">
                      profile incomplete
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-[var(--muted)]">{employee.email}</td>
                <td className="px-3 py-2">
                  {employee.position?.name ??
                    (employee.positionOther !== null ? (
                      <span title="Free text - needs admin cleanup">
                        {employee.positionOther}{" "}
                        <span className="text-[var(--muted)]">(other)</span>
                      </span>
                    ) : (
                      <span className="text-[var(--muted)]">—</span>
                    ))}
                </td>
                <td className="px-3 py-2">
                  {employee.department?.name ?? (
                    <span className="text-[var(--muted)]">—</span>
                  )}
                </td>
                <td className="px-3 py-2">
                  {employee.status === "active" ? (
                    "Active"
                  ) : (
                    <span className="text-red-700">Disabled</span>
                  )}
                </td>
                <td className="px-3 py-2 text-[var(--muted)]">
                  {formatDate(employee.lastLoginAt)}
                </td>
                {modules.map((m) => (
                  <td key={m.key} className="px-3 py-2">
                    {employee.grantedModuleKeys.includes(m.key) ? (
                      <span aria-label="granted">Yes</span>
                    ) : (
                      <span className="text-[var(--muted)]" aria-label="not granted">
                        —
                      </span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex items-center justify-between text-sm text-[var(--muted)]">
        <span>
          {first}–{last} of {total}
        </span>
        <span className="flex items-center gap-3">
          {page > 1 && (
            <Link href={pageHref(page - 1)} className="underline underline-offset-2">
              Previous
            </Link>
          )}
          <span>
            Page {page} of {totalPages}
          </span>
          {page < totalPages && (
            <Link href={pageHref(page + 1)} className="underline underline-offset-2">
              Next
            </Link>
          )}
        </span>
      </div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 font-medium">{children}</th>;
}

function SortableTh({
  column,
  active,
  dir,
  href,
  children,
}: {
  column: "name" | "lastLogin" | "status";
  active: string;
  dir: "asc" | "desc";
  href: string;
  children: React.ReactNode;
}) {
  const isActive = active === column;

  return (
    <th
      className="px-3 py-2 font-medium"
      // Announced rather than only drawn: a caret is invisible to a screen
      // reader, and this table is how access is administered.
      aria-sort={isActive ? (dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <Link href={href} className="inline-flex items-center gap-1 hover:underline">
        {children}
        <span aria-hidden="true" className={isActive ? "" : "text-[var(--border)]"}>
          {isActive && dir === "desc" ? "▾" : "▴"}
        </span>
      </Link>
    </th>
  );
}

function formatDate(value: Date | string | null): string {
  if (value === null) return "Never";
  const date = typeof value === "string" ? new Date(value) : value;
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
