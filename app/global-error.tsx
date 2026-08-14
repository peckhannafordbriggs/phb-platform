"use client";

/**
 * Last-resort boundary: catches failures in the root layout itself, so it has
 * to render its own <html> and <body>.
 */
export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  return (
    <html lang="en">
      <body>
        <main style={{ maxWidth: "32rem", margin: "6rem auto", padding: "0 1.5rem" }}>
          <h1 style={{ fontSize: "1.25rem", fontWeight: 600 }}>
            The platform failed to load
          </h1>
          <p style={{ marginTop: "0.75rem", color: "#5b6570" }}>
            Reload the page. If it keeps happening, contact whoever administers
            the platform.
          </p>
          {error.digest !== undefined && (
            <p style={{ marginTop: "0.75rem", fontSize: "0.75rem", color: "#5b6570" }}>
              Reference: <code>{error.digest}</code>
            </p>
          )}
        </main>
      </body>
    </html>
  );
}
