"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { hasSettingsSurface } from "@/lib/module-settings";

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
  profileCompleted,
  modules,
  grantedModuleKeys,
  moduleAdminKeys,
}: {
  employeeId: string;
  isSelf: boolean;
  status: "active" | "disabled";
  isPlatformAdmin: boolean;
  profileCompleted: boolean;
  modules: { key: string; displayName: string }[];
  grantedModuleKeys: string[];
  /** Subset of grantedModuleKeys whose grant carries is_module_admin (B7.2). */
  moduleAdminKeys: string[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

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

  function setAdmin(moduleKey: string, isModuleAdmin: boolean) {
    void call(
      `/api/admin/employees/${employeeId}/grants/${encodeURIComponent(moduleKey)}/admin`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isModuleAdmin }),
      },
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
              const isAdmin = moduleAdminKeys.includes(module.key);
              return (
                <div key={module.key}>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={granted}
                      disabled={busy}
                      onChange={() => setGrant(module.key, !granted)}
                    />
                    {module.displayName}
                  </label>

                  {/*
                    Administrator of this ONE module - for Building Automation,
                    the Settings tab. Not the platform admin flag below, which is
                    a much larger thing.

                    Only offered once access is granted. The server refuses it
                    outright without a grant, because "administrator of a module
                    you cannot open" is not a state worth being able to reach,
                    and a checkbox that quietly granted access as a side effect
                    would do two things the audit log records as one.

                    AND ONLY FOR A MODULE THAT HAS SETTINGS. Change Orders has
                    none - it is configured in Exchange and in the flows - so the
                    box used to offer a permission whose only effect was to reach
                    a page that does not exist. Hiding it is a rendering
                    decision; `setModuleAdmin` refuses the same request, which is
                    what makes the permission unreachable rather than unoffered.

                    The exception is a flag that is already set. A module could
                    lose its settings screen, or have been ticked before this
                    rule existed, and hiding a live permission is how it becomes
                    permanent - the server still allows clearing it precisely so
                    this checkbox can.
                  */}
                  {granted && (hasSettingsSurface(module.key) || isAdmin) && (
                    <label className="mt-1 ml-6 flex items-center gap-2 text-xs text-[var(--muted)]">
                      <input
                        type="checkbox"
                        checked={isAdmin}
                        disabled={busy}
                        onChange={() => setAdmin(module.key, !isAdmin)}
                      />
                      {hasSettingsSurface(module.key) ? (
                        <>Can change settings for {module.displayName}</>
                      ) : (
                        <>
                          Can change settings for {module.displayName} —{" "}
                          <span className="text-[var(--warning)]">
                            this module has no settings screen. Clear this.
                          </span>
                        </>
                      )}
                    </label>
                  )}
                </div>
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

        {/*
          The one correction for a profile holding words nobody chose. Not an
          edit: the name comes from Microsoft and the profile is the person's
          own, so this re-runs onboarding instead. It ends their session on
          purpose - the name is stamped at sign-in, and a form opened from a
          live session would prefill the old words. The confirmation says so.
        */}
        <div className="border-t border-[var(--border)] pt-4">
          {!confirmReset ? (
            <button
              type="button"
              disabled={busy || status === "disabled"}
              title={
                status === "disabled"
                  ? "A disabled employee cannot sign in to complete a profile."
                  : undefined
              }
              onClick={() => setConfirmReset(true)}
              className="rounded border border-[var(--border)] px-3 py-1.5 text-sm disabled:opacity-50"
            >
              Ask to complete profile again
            </button>
          ) : (
            <div className="rounded border border-[var(--border)] bg-[var(--surface)] px-3 py-3 text-sm">
              <p>
                {isSelf ? "You" : "This person"} will be signed out on{" "}
                {isSelf ? "your" : "their"} next click and asked to complete{" "}
                {isSelf ? "your" : "their"} profile again. The name is taken from
                Microsoft again at that sign-in.
                {profileCompleted
                  ? ""
                  : " The profile is already incomplete; this still ends the session and refreshes the name."}
              </p>
              <div className="mt-3 flex gap-3">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setConfirmReset(false);
                    void call(`/api/admin/employees/${employeeId}/profile-reset`, {
                      method: "POST",
                    });
                  }}
                  className="rounded border border-[var(--border)] px-3 py-1.5 text-sm disabled:opacity-50"
                >
                  Sign out and ask
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirmReset(false)}
                  className="rounded px-3 py-1.5 text-sm text-[var(--muted)]"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
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
