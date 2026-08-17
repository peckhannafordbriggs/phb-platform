"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface ListItem {
  id: string;
  name: string;
}

/** Same sentinel the onboarding form uses, so the two behave identically. */
const OTHER = "__other__";

export function ProfileForm({
  positions,
  currentPositionId,
  currentPositionOther,
}: {
  positions: ListItem[];
  currentPositionId: string | null;
  currentPositionOther: string | null;
}) {
  const router = useRouter();

  // A row that is on a hidden position, or on free text, starts on "Other" with
  // the existing text - so saving does not silently reassign it.
  const [positionChoice, setPositionChoice] = useState(() => {
    if (currentPositionId !== null) return currentPositionId;
    if (currentPositionOther !== null) return OTHER;
    return "";
  });
  const [positionOther, setPositionOther] = useState(currentPositionOther ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSaved(false);
    setSubmitting(true);

    try {
      // Position only. Sending a department, an email or an admin flag from here
      // would be rejected by the server, which is the point - this form is a
      // convenience over an endpoint that only accepts these two fields.
      const response = await fetch("/api/me/position", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          positionId: positionChoice === OTHER ? null : positionChoice || null,
          positionOther: positionChoice === OTHER ? positionOther : null,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(payload?.error?.message ?? "The submitted values are not valid.");
        return;
      }

      setSaved(true);
      router.refresh();
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-4 max-w-md space-y-5">
      <label className="block">
        <span className="mb-1 block text-sm font-medium">Position</span>
        <select
          required
          value={positionChoice}
          onChange={(e) => {
            setPositionChoice(e.target.value);
            setSaved(false);
          }}
          className="w-full rounded border border-[var(--border)] bg-white px-3 py-2 text-sm"
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
        <label className="block">
          <span className="mb-1 block text-sm font-medium">
            Describe your position
          </span>
          <input
            required
            value={positionOther}
            onChange={(e) => {
              setPositionOther(e.target.value);
              setSaved(false);
            }}
            className="w-full rounded border border-[var(--border)] px-3 py-2 text-sm"
          />
          <span className="mt-1 block text-xs text-[var(--muted)]">
            An administrator may replace this with a value from the list.
          </span>
        </label>
      )}

      {error !== null && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}

      {saved && (
        <p role="status" className="text-sm text-green-700">
          Position saved.
        </p>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="rounded bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {submitting ? "Saving..." : "Save position"}
      </button>
    </form>
  );
}
