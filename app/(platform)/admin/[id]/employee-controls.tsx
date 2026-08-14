"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Convenience controls. Every guardrail they express - no self-demotion, no
 * self-disable, never zero active admins - is enforced again on the server,
 * which is what actually protects the platform. Disabling a button here only
 * saves a round trip.
 */
export function EmployeeControls({
  employeeId,
  isSelf,
  status,
  isPlatformAdmin,
  modules,
  grantedModuleKeys,
}: {
  employeeId: string;
  isSelf: boolean;
  status: "active" | "disabled";
  isPlatformAdmin: boolean;
  modules: { key: string; displayName: string }[];
  grantedModuleKeys: string[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function call(path: string, init: RequestInit) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(path, init);
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(payload?.error?.message ?? "The action could not be completed.");
        return;
      }
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  function setGrant(moduleKey: string, granted: boolean) {
    void call(
      granted
        ? `/api/admin/employees/${employeeId}/grants`
        : `/api/admin/employees/${employeeId}/grants/${encodeURIComponent(moduleKey)}`,
      granted
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ moduleKey }),
          }
        : { method: "DELETE" },
    );
  }

  return (
    <section className="mt-6 rounded border border-[var(--border)]">
      <h2 className="border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-semibold">
        Access
      </h2>

      <div className="space-y-4 px-4 py-4">
        <div>
          <p className="text-xs font-medium text-[var(--muted)]">Modules</p>
          <div className="mt-2 space-y-2">
            {modules.map((module) => {
              const granted = grantedModuleKeys.includes(module.key);
              return (
                <label key={module.key} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={granted}
                    disabled={busy}
                    onChange={() => setGrant(module.key, !granted)}
                  />
                  {module.displayName}
                </label>
              );
            })}
            {modules.length === 0 && (
              <p className="text-sm text-[var(--muted)]">
                No active modules exist.
              </p>
            )}
          </div>
        </div>

        <div className="flex flex-wrap gap-3 border-t border-[var(--border)] pt-4">
          <button
            type="button"
            disabled={busy || isSelf}
            title={isSelf ? "You cannot disable your own account." : undefined}
            onClick={() =>
              void call(`/api/admin/employees/${employeeId}/status`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  status: status === "active" ? "disabled" : "active",
                }),
              })
            }
            className="rounded border border-[var(--border)] px-3 py-1.5 text-sm disabled:opacity-50"
          >
            {status === "active" ? "Disable account" : "Enable account"}
          </button>

          <button
            type="button"
            disabled={busy || (isSelf && isPlatformAdmin)}
            title={
              isSelf && isPlatformAdmin
                ? "You cannot remove your own administrator access."
                : undefined
            }
            onClick={() =>
              void call(`/api/admin/employees/${employeeId}/admin-flag`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ isPlatformAdmin: !isPlatformAdmin }),
              })
            }
            className="rounded border border-[var(--border)] px-3 py-1.5 text-sm disabled:opacity-50"
          >
            {isPlatformAdmin ? "Remove admin" : "Make admin"}
          </button>
        </div>

        {error !== null && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
