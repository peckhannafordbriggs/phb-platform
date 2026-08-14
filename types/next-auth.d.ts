import type { DefaultSession } from "next-auth";

/**
 * The session carries identity only.
 *
 * It must never carry module grants or isPlatformAdmin: those are read from the
 * database on every request so that revocation takes effect immediately rather
 * than at next sign-out. See docs/04-auth-and-permissions.md.
 */
declare module "next-auth" {
  interface Session {
    /** Entra object ID. The stable key for the employee row. */
    entraOid: string | null;
    /** Token issue time, seconds since epoch. Compared to sessionsValidAfter. */
    issuedAt: number | null;
    user: DefaultSession["user"];
  }
}

export {};
