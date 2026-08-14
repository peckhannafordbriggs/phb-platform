"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface ListItem {
  id: string;
  name: string;
}

const OTHER = "__other__";

export function OnboardingForm({
  email,
  firstName: initialFirstName,
  lastName: initialLastName,
  positions,
  departments,
}: {
  email: string;
  firstName: string;
  lastName: string;
  positions: ListItem[];
  departments: ListItem[];
}) {
  const router = useRouter();

  const [firstName, setFirstName] = useState(initialFirstName);
  const [lastName, setLastName] = useState(initialLastName);
  const [positionChoice, setPositionChoice] = useState("");
  const [positionOther, setPositionOther] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      // The email is not in this payload. It comes from the token server-side,
      // and the server would ignore it anyway.
      const response = await fetch("/api/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName,
          lastName,
          positionId: positionChoice === OTHER ? null : positionChoice || null,
          positionOther: positionChoice === OTHER ? positionOther : null,
          departmentId: departmentId || null,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(
          payload?.error?.message ?? "The submitted values are not valid.",
        );
        return;
      }

      router.push("/");
      router.refresh();
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-8 space-y-5">
      <Field label="Email">
        {/* Read-only. A user-entered address that disagrees with the
            authenticated identity is unresolvable. */}
        <input
          type="email"
          value={email}
          disabled
          readOnly
          className="w-full cursor-not-allowed rounded border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--muted)]"
        />
        <p className="mt-1 text-xs text-[var(--muted)]">
          From your Microsoft account. This cannot be changed here.
        </p>
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field label="First name">
          <input
            required
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            className="w-full rounded border border-[var(--border)] px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Last name">
          <input
            required
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            className="w-full rounded border border-[var(--border)] px-3 py-2 text-sm"
          />
        </Field>
      </div>

      <Field label="Position">
        <select
          required
          value={positionChoice}
          onChange={(e) => setPositionChoice(e.target.value)}
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
      </Field>

      {positionChoice === OTHER && (
        <Field label="Describe your position">
          <input
            required
            value={positionOther}
            onChange={(e) => setPositionOther(e.target.value)}
            className="w-full rounded border border-[var(--border)] px-3 py-2 text-sm"
          />
        </Field>
      )}

      <Field label="Department">
        <select
          required
          value={departmentId}
          onChange={(e) => setDepartmentId(e.target.value)}
          className="w-full rounded border border-[var(--border)] bg-white px-3 py-2 text-sm"
        >
          <option value="">Select...</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </Field>

      {error !== null && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="rounded bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {submitting ? "Saving..." : "Continue"}
      </button>
    </form>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">{label}</span>
      {children}
    </label>
  );
}
