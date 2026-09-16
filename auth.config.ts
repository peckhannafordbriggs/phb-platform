import type { NextAuthConfig } from "next-auth";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";

/**
 * Edge-safe half of the Auth.js configuration.
 *
 * middleware.ts imports this file and nothing else, so it must stay free of
 * Prisma, of lib/env.ts, and of anything that reads process.env dynamically -
 * the edge runtime only exposes statically referenced variables.
 *
 * The database-backed callbacks live in auth.ts, which runs on Node.
 */
export const authConfig = {
  providers: [
    // THE EDGE COPY. middleware.ts checks for a session with this provider and
    // never exchanges an authorization code, so the credential below is never
    // used from here. The provider that DOES exchange codes is built in
    // auth.ts, on Node, by lib/auth/entra-provider.ts - with this secret
    // locally, and in production with the managed identity's token as a
    // client_assertion, because production carries no secret (CLAUDE.md
    // prohibition 7) and Entra refused the secret-less exchange as
    // `invalid_client` the first time anyone signed in (2026-09-16).
    MicrosoftEntraID({
      clientId: process.env.AUTH_MICROSOFT_ENTRA_ID_ID,
      // Set locally; NOT set in Azure. `undefined` in production, by design.
      clientSecret: process.env.AUTH_MICROSOFT_ENTRA_ID_SECRET,
      issuer: `https://login.microsoftonline.com/${process.env.AUTH_MICROSOFT_ENTRA_ID_TENANT_ID}/v2.0`,
    }),
  ],

  // JWT, not database sessions. There is deliberately no Prisma adapter: the
  // adapter would create its own User and Account tables, a second identity
  // store alongside Employee. Employee is the only one.
  session: { strategy: "jwt" },

  pages: {
    signIn: "/signin",
    // Every gate failure lands here, with no detail about which check failed.
    error: "/unauthorized",
    signOut: "/signin",
  },

  trustHost: true,
} satisfies NextAuthConfig;

export default authConfig;
