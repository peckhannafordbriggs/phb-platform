"use client";

import { Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui";
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
 *
 * Drawn with the kit since 2026-11-13: the button is a kit button on the
 * header row, the panel a card, the Copy buttons the kit's small primary.
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
      <Button onClick={() => setOpen((o) => !o)} ariaExpanded={open}>
        <Copy size={16} aria-hidden="true" />
        Copy invite email
      </Button>

      {open && (
        <div
          role="dialog"
          aria-label="Invite email"
          draggable={false}
          onDragStart={(e) => e.preventDefault()}
          className="card absolute right-0 z-20 mt-2 w-[min(36rem,calc(100vw-2rem))] select-none p-4 text-left"
        >
          <p className="text-[0.8125rem] text-[var(--muted)]">
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
            <p role="alert" className="mt-2 text-[0.8125rem] text-[var(--phb-maroon)]">
              Your browser blocked copying. Try again, or use a different browser.
            </p>
          )}

          <div className="mt-3 flex justify-end">
            <Button size="sm" onClick={() => setOpen(false)}>
              Close
            </Button>
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
        <span className="eyebrow text-[var(--muted)]">{label}</span>
        <Button size="sm" variant="primary" onClick={onCopy}>
          {done ? "Copied" : "Copy"}
        </Button>
      </div>
      <div className="whitespace-pre-wrap rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[0.8125rem] leading-relaxed">
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
