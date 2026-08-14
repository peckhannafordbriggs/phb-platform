import { signOut } from "@/auth";

export const dynamic = "force-dynamic";

/**
 * Every login-gate failure lands here.
 *
 * No detail, deliberately: which of the four checks failed is recorded in the
 * audit event and the server log, and is never shown to the person rejected.
 */
export default function UnauthorizedPage() {
  async function signOutAction(): Promise<void> {
    "use server";
    await signOut({ redirectTo: "/signin" });
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <h1 className="text-xl font-semibold">Not authorized for this application</h1>
      <p className="mt-3 text-sm text-[var(--muted)]">
        If you believe this is a mistake, contact whoever administers the
        platform.
      </p>

      <form action={signOutAction} className="mt-8">
        <button
          type="submit"
          className="rounded border border-[var(--border)] px-4 py-2 text-sm hover:bg-[var(--surface)]"
        >
          Sign out
        </button>
      </form>
    </main>
  );
}
