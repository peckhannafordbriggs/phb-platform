"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface ListItem {
  id: string;
  name: string;
}

/** Same sentinel the onboarding and self-service forms use. */
const OTHER = "__other__";

/**
 * Admin edits to an employee's profile: department, and position.
 *
 * Department is admin-only and has no self-service equivalent. Position is also
 * editable by the employee themselves at /profile - both go through the same
 * endpoint logic, so an admin's change and the employee's own change cannot
 * disagree about what a valid position is. Whoever saved last wins, and the audit
 * trail records which of them it was.
 */
export function ProfileControls({
  employeeId,
  positions,
  departments,
  currentPositionId,
  currentPositionOther,
  currentDepartmentId,
}: {
  employeeId: string;
  positions: ListItem[];
  departments: ListItem[];
  currentPositionId: string | null;
  currentPositionOther: string | null;
  currentDepartmentId: string | null;
}) {
  const router = useRouter();

  const [departmentId, setDepartmentId] = useState(currentDepartmentId ?? "");
  const [positionChoice, setPositionChoice] = useState(() => {
    if (currentPositionId !== null) return currentPositionId;
    if (currentPositionOther !== null) return OTHER;
    return "";
  });
  const [positionOther, setPositionOther] = useState(currentPositionOther ?? "");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  async function call(path: string, body: unknown, savedLabel: string) {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const response = await fetch(path, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(payload?.error?.message ?? "The change could not be saved.");
        return;
      }

      setSaved(savedLabel);
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-6 rounded border border-[var(--border)]">
      <h2 className="border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-semibold">
        Edit profile
      </h2>

      <div className="space-y-5 px-4 py-4">
        <div>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-[var(--muted)]">
              Department
            </span>
            <select
              value={departmentId}
              disabled={busy}
              onChange={(e) => setDepartmentId(e.target.value)}
              className="w-full max-w-xs rounded border border-[var(--border)] bg-white px-3 py-2 text-sm"
            >
              <option value="">Not set</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <p className="mt-1 text-xs text-[var(--muted)]">
            Admin-controlled. Employees cannot change their own department.
          </p>
          <button
            type="button"
            disabled={busy || departmentId === "" || departmentId === currentDepartmentId}
            onClick={() =>
              void call(
                `/api/admin/employees/${employeeId}/department`,
                { departmentId },
                "Department saved.",
              )
            }
            className="mt-2 rounded border border-[var(--border)] px-3 py-1.5 text-sm disabled:opacity-50"
          >
            Save department
          </button>
        </div>

        <div className="border-t border-[var(--border)] pt-5">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-[var(--muted)]">
              Position
            </span>
            <select
              value={positionChoice}
              disabled={busy}
              onChange={(e) => setPositionChoice(e.target.value)}
              className="w-full max-w-xs rounded border border-[var(--border)] bg-white px-3 py-2 text-sm"
            >
              <option value="">Select...</option>
              {positions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
              <option value={OTHER}>Other</option>
            </select>
          </label>

          {positionChoice === OTHER && (
            <label className="mt-2 block">
              <span className="mb-1 block text-xs font-medium text-[var(--muted)]">
                Free-text position
              </span>
              <input
                value={positionOther}
                disabled={busy}
                onChange={(e) => setPositionOther(e.target.value)}
                className="w-full max-w-xs rounded border border-[var(--border)] px-3 py-2 text-sm"
              />
            </label>
          )}

          <p className="mt-1 text-xs text-[var(--muted)]">
            The employee can also change this themselves.
          </p>
          <button
            type="button"
            disabled={
              busy ||
              positionChoice === "" ||
              (positionChoice === OTHER && positionOther.trim() === "")
            }
            onClick={() =>
              void call(
                `/api/admin/employees/${employeeId}/position`,
                {
                  positionId:
                    positionChoice === OTHER ? null : positionChoice || null,
                  positionOther:
                    positionChoice === OTHER ? positionOther : null,
                },
                "Position saved.",
              )
            }
            className="mt-2 rounded border border-[var(--border)] px-3 py-1.5 text-sm disabled:opacity-50"
          >
            Save position
          </button>
        </div>

        {error !== null && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
        {saved !== null && (
          <p role="status" className="text-sm text-green-700">
            {saved}
          </p>
        )}
      </div>
    </section>
  );
}
