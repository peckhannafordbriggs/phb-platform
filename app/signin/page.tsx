import Image from "next/image";
import { signIn } from "@/auth";

export const dynamic = "force-dynamic";

/**
 * The one place to be generous.
 *
 * Nobody is trying to get work done here, so this is where the mark gets room:
 * a purple field, the logo at a size where its quartering is actually legible,
 * and one button. Every other screen in the platform spends its restraint
 * budget so this one does not have to.
 */
export default function SignInPage() {
  async function signInAction(): Promise<void> {
    "use server";
    await signIn("microsoft-entra-id", { redirectTo: "/" });
  }

  return (
    <main className="chrome relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-[var(--chrome)] px-6 py-12 text-[var(--chrome-text)]">
      {/*
        The empty-state motif, used here as a field rather than as a message: a
        large quartered diamond at very low opacity. Same shape as the active
        module indicator and the section eyebrows - one idea, three sizes.
      */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-24 -top-24 h-[28rem] w-[28rem] rotate-45 opacity-[0.055]"
      >
        <div className="grid h-full w-full grid-cols-2 grid-rows-2">
          <span style={{ background: "var(--phb-red)" }} />
          <span style={{ background: "var(--phb-orange)" }} />
          <span style={{ background: "var(--phb-cyan)" }} />
          <span style={{ background: "var(--phb-teal)" }} />
        </div>
      </div>

      <div className="relative w-full max-w-sm">
        <Image
          src="/phb-logo.png"
          alt="Peck Hannaford + Briggs"
          width={104}
          height={104}
          priority
        />

        <h1 className="mt-7 font-[family-name:var(--font-display)] text-[1.75rem] font-semibold uppercase leading-[1.1] tracking-[0.01em]">
          Peck Hannaford
          <br />
          <span className="text-[var(--chrome-muted)]">+ Briggs</span>
        </h1>

        {/* The single diagonal, at the scale this page can carry. */}
        <div className="quad-band mt-5 w-40" aria-hidden="true">
          <span style={{ background: "var(--phb-red)" }} />
          <span style={{ background: "var(--phb-orange)" }} />
          <span style={{ background: "var(--phb-cyan)" }} />
          <span style={{ background: "var(--phb-teal)" }} />
        </div>

        <form action={signInAction} className="mt-8">
          <button
            type="submit"
            className="w-full rounded bg-white px-4 py-2.5 font-[family-name:var(--font-display)] text-sm font-semibold text-[var(--phb-purple)] transition-colors hover:bg-[var(--neutral-100)]"
          >
            Sign in with Microsoft
          </button>
        </form>

        <p className="mt-6 text-xs leading-relaxed text-[var(--chrome-muted)]">
          Use your Peck Hannaford + Briggs account. The platform never stores a
          password and never creates accounts.
        </p>
      </div>
    </main>
  );
}
