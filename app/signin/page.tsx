import { signIn } from "@/auth";

export const dynamic = "force-dynamic";

export default function SignInPage() {
  async function signInAction(): Promise<void> {
    "use server";
    await signIn("microsoft-entra-id", { redirectTo: "/" });
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <h1 className="text-2xl font-semibold tracking-tight">PHB Platform</h1>
      <p className="mt-2 text-sm text-[var(--muted)]">
        Peck Hannaford + Briggs internal systems.
      </p>

      <form action={signInAction} className="mt-8">
        <button
          type="submit"
          className="w-full rounded bg-[var(--accent)] px-4 py-2.5 text-sm font-medium text-white"
        >
          Sign in with Microsoft
        </button>
      </form>

      <p className="mt-6 text-xs text-[var(--muted)]">
        Use your Peck Hannaford + Briggs account. The platform never stores a
        password.
      </p>
    </main>
  );
}
