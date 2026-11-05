/**
 * The invite email an admin copies from the Employees screen and sends
 * themselves, from their own mailbox.
 *
 * The platform never sends this. CLAUDE.md prohibition 1 ("one human, one
 * draft, one deliberate action") is written about the change-order mailbox, but
 * the same shape holds here: the admin pastes it into Outlook, picks the
 * recipients, and presses Send. There is also no create-employee endpoint, so
 * an invite cannot pre-create anybody; it only tells a person where to sign in.
 * Their first sign-in self-provisions a row with zero grants, as always.
 *
 * The URL is the production address on purpose, not AUTH_URL: an invite copied
 * from a developer's machine would otherwise point colleagues at localhost.
 */

export const PLATFORM_PUBLIC_URL = "https://platform.phb1899.com";

export interface InviteEmail {
  subject: string;
  body: string;
}

/**
 * The sign-off is a bare "Thanks," on purpose: the admin's Outlook signature
 * supplies the name, so the invite takes no inviter details.
 */
export function buildInviteEmail(): InviteEmail {
  const signOff = "Thanks,";

  const body = [
    "Hi,",
    "",
    "You've been invited to the PH+B Platform, our internal company platform.",
    "",
    "Getting set up takes about a minute:",
    "",
    `1. Open ${PLATFORM_PUBLIC_URL}`,
    '2. Click "Sign in with Microsoft" and sign in with your PH+B work account (the same one you use for Outlook).',
    "3. Fill in the short profile form it shows you the first time.",
    "4. Reply to this email to let me know you've signed up.",
    "",
    "You won't see any modules until your access is granted, so once I hear from you I'll set you up.",
    "",
    signOff,
  ].join("\n");

  return {
    subject: "You're invited to the PH+B Platform",
    body,
  };
}
