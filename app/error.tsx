"use client";

import { useEffect } from "react";

/**
 * Route-level error boundary.
 *
 * The browser gets a generic message. The detail is already in the server log,
 * where docs/07-conventions.md says it belongs - a stack trace is never
 * returned to the user.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(
      JSON.stringify({
        level: "error",
        event: "client.route_error",
        time: new Date().toISOString(),
        digest: error.digest ?? null,
      }),
    );
  }, [error]);

  return (
    <main className="mx-auto max-w-lg px-6 py-24">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="mt-3 text-sm text-[var(--muted)]">
        The page could not be loaded. Try again; if it keeps happening, contact
        whoever administers the platform.
      </p>
      {error.digest !== undefined && (
        <p className="mt-3 text-xs text-[var(--muted)]">
          Reference: <code>{error.digest}</code>
        </p>
      )}
      <button
        type="button"
        onClick={reset}
        className="mt-6 rounded border border-[var(--border)] px-4 py-2 text-sm hover:bg-[var(--surface)]"
      >
        Try again
      </button>
    </main>
  );
}
