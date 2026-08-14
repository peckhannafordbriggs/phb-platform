"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

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
  totalPages,
}: {
  employees: AdminEmployeeRow[];
  modules: { key: string; displayName: string }[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  async function runBulk(moduleKey: string, action: "grant" | "revoke") {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/grants/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employeeIds: [...selected],
          moduleKey,
          action,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(payload?.error?.message ?? "The action could not be completed.");
        return;
      }

      setSelected(new Set());
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  function pageHref(target: number): string {
    const params = new URLSearchParams(searchParams.toString());
    params.set("page", String(target));
    return `/admin?${params.toString()}`;
  }

  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <div className="mt-6">
      {selected.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
          <span className="text-sm font-medium">
            {selected.size} selected
          </span>
          {modules.map((m) => (
            <span key={m.key} className="flex items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void runBulk(m.key, "grant")}
                className="rounded border border-[var(--border)] bg-white px-3 py-1 text-xs disabled:opacity-50"
              >
                Grant {m.displayName}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void runBulk(m.key, "revoke")}
                className="rounded border border-[var(--border)] bg-white px-3 py-1 text-xs disabled:opacity-50"
              >
                Revoke {m.displayName}
              </button>
            </span>
          ))}
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="text-xs text-[var(--muted)] underline underline-offset-2"
          >
            Clear
          </button>
        </div>
      )}

      {error !== null && (
        <p role="alert" className="mb-3 text-sm text-red-700">
          {error}
        </p>
      )}

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
              <Th>Name</Th>
              <Th>Email</Th>
              <Th>
                Position{" "}
                <span className="font-normal italic text-[var(--muted)]">
                  self-reported
                </span>
              </Th>
              <Th>Department</Th>
              <Th>Status</Th>
              <Th>Last sign-in</Th>
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
                  className="px-3 py-8 text-center text-[var(--muted)]"
                >
                  No employees match these filters.
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

function formatDate(value: Date | string | null): string {
  if (value === null) return "Never";
  const date = typeof value === "string" ? new Date(value) : value;
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
