"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface ListItem {
  id: string;
  name: string;
  status: "active" | "hidden";
  /**
   * How many employees hold this value.
   *
   * PHASE-10: "so an admin knows what a rename affects". A rename that touches
   * ninety records is a different decision from one that touches none, and
   * hiding a value nobody holds is free where hiding a busy one is not.
   */
  employeeCount: number;
}

/** Add, rename, hide. There is deliberately no delete. */
export function ListEditor({
  title,
  endpoint,
  items,
}: {
  title: string;
  endpoint: "positions" | "departments";
  items: ListItem[];
}) {
  const router = useRouter();
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function call(path: string, init: RequestInit): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(path, init);
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(payload?.error?.message ?? "The action could not be completed.");
        return false;
      }
      router.refresh();
      return true;
    } catch {
      setError("Could not reach the server.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (newName.trim().length === 0) return;

    const created = await call(`/api/admin/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName.trim() }),
    });
    if (created) setNewName("");
  }

  async function saveRename(id: string) {
    const saved = await call(`/api/admin/${endpoint}/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: editingName.trim() }),
    });
    if (saved) setEditingId(null);
  }

  function setStatus(id: string, status: "active" | "hidden") {
    void call(`/api/admin/${endpoint}/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
  }

  return (
    <section className="rounded border border-[var(--border)]">
      <h2 className="border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-semibold">
        {title}
      </h2>

      <ul className="divide-y divide-[var(--border)]">
        {items.map((item) => (
          <li
            key={item.id}
            className="flex items-center justify-between gap-2 px-4 py-2 text-sm"
          >
            {editingId === item.id ? (
              <>
                <input
                  value={editingName}
                  onChange={(e) => setEditingName(e.target.value)}
                  className="min-w-0 flex-1 rounded border border-[var(--border)] px-2 py-1 text-sm"
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void saveRename(item.id)}
                  className="text-xs text-[var(--accent)] underline underline-offset-2"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => setEditingId(null)}
                  className="text-xs text-[var(--muted)] underline underline-offset-2"
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <span className="flex min-w-0 flex-1 items-baseline gap-2">
                  <span
                    className={
                      item.status === "hidden"
                        ? "min-w-0 truncate text-[var(--muted)] line-through"
                        : "min-w-0 truncate"
                    }
                  >
                    {item.name}
                  </span>
                  <span
                    className="shrink-0 text-xs text-[var(--muted)]"
                    title={
                      item.employeeCount === 0
                        ? "Nobody holds this value"
                        : "Includes disabled employees, who still hold it"
                    }
                  >
                    {item.employeeCount === 0 ? "unused" : `${item.employeeCount}`}
                  </span>
                  {item.status === "hidden" && item.employeeCount > 0 && (
                    <span className="shrink-0 text-xs italic text-[var(--muted)]">
                      still assigned
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setEditingId(item.id);
                    setEditingName(item.name);
                  }}
                  className="text-xs text-[var(--muted)] underline underline-offset-2"
                >
                  Rename
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    setStatus(
                      item.id,
                      item.status === "active" ? "hidden" : "active",
                    )
                  }
                  className="text-xs text-[var(--muted)] underline underline-offset-2"
                  title={
                    item.status === "active" && item.employeeCount > 0
                      ? `${item.employeeCount} employee(s) keep this value. Hiding only removes it from the dropdowns.`
                      : undefined
                  }
                >
                  {item.status === "active" ? "Hide" : "Restore"}
                </button>
              </>
            )}
          </li>
        ))}
      </ul>

      <form onSubmit={add} className="flex gap-2 border-t border-[var(--border)] px-4 py-3">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder={`Add a ${title.slice(0, -1).toLowerCase()}`}
          className="min-w-0 flex-1 rounded border border-[var(--border)] px-2 py-1 text-sm"
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-[var(--accent)] px-3 py-1 text-sm text-white disabled:opacity-50"
        >
          Add
        </button>
      </form>

      {error !== null && (
        <p role="alert" className="px-4 pb-3 text-sm text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}
