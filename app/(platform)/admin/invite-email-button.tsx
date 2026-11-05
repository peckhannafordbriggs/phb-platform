"use client";

import { useState } from "react";
import type { InviteEmail } from "@/lib/admin/invite-email";

/**
 * "Copy invite email": shows the invite and copies it to the clipboard.
 *
 * Copy only. The admin pastes it into their own Outlook and sends it; nothing
 * here sends mail or knows who the recipients are. See lib/admin/invite-email.ts.
 *
 * The preview is plain text, not a form field: it cannot be focused, edited,
 * selected or dragged. A read-only input looked editable and selected all on
 * click (2026-11-05), so the Copy buttons are the only way the text leaves.
 */
export function InviteEmailButton({ email }: { email: InviteEmail }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<"subject" | "body" | null>(null);
  const [failed, setFailed] = useState(false);

  async function copy(which: "subject" | "body"): Promise<void> {
    const text = which === "subject" ? email.subject : email.body;
    setFailed(false);
    const ok = (await writeClipboard(text)) || legacyCopy(text);
    if (!ok) {
      setFailed(true);
      return;
    }
    setCopied(which);
    window.setTimeout(() => setCopied((c) => (c === which ? null : c)), 2000);
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="cursor-pointer rounded border border-[var(--border)] px-3 py-1 text-sm font-medium text-[var(--accent)] transition-colors hover:bg-[var(--neutral-100)]"
      >
        Copy invite email
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Invite email"
          draggable={false}
          onDragStart={(e) => e.preventDefault()}
          className="absolute right-0 z-20 mt-2 w-[min(36rem,calc(100vw-2rem))] select-none rounded border border-[var(--border)] bg-white p-4 text-left shadow-lg"
        >
          <p className="text-sm text-[var(--muted)]">
            Paste this into a new email in Outlook and send it to the people you
            want to invite. They appear on this screen after their first sign-in.
          </p>

          <Section label="Subject" done={copied === "subject"} onCopy={() => copy("subject")}>
            {email.subject}
          </Section>

          <Section label="Body" done={copied === "body"} onCopy={() => copy("body")}>
            {email.body}
          </Section>

          {failed && (
            <p role="alert" className="mt-2 text-sm text-[var(--phb-maroon)]">
              Your browser blocked copying. Try again, or use a different browser.
            </p>
          )}

          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="cursor-pointer px-2 py-1 text-sm text-[var(--muted)] underline underline-offset-2 hover:text-[var(--foreground)]"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({
  label,
  done,
  onCopy,
  children,
}: {
  label: string;
  done: boolean;
  onCopy: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-[var(--muted)]">{label}</span>
        <button
          type="button"
          onClick={onCopy}
          className="cursor-pointer rounded bg-[var(--accent)] px-2.5 py-0.5 text-xs font-medium text-white transition-opacity hover:opacity-85 active:opacity-70"
        >
          {done ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="whitespace-pre-wrap rounded border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm leading-relaxed">
        {children}
      </div>
    </div>
  );
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Fallback for browsers that refuse the async Clipboard API. Off-screen, never shown. */
function legacyCopy(text: string): boolean {
  const el = document.createElement("textarea");
  el.value = text;
  el.setAttribute("readonly", "");
  el.style.position = "fixed";
  el.style.left = "-9999px";
  document.body.appendChild(el);
  el.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(el);
  return ok;
}
