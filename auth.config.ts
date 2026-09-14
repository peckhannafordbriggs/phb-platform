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
    MicrosoftEntraID({
      clientId: process.env.AUTH_MICROSOFT_ENTRA_ID_ID,
      // Set locally; NOT set in Azure - infra/main.bicep defines only the client
      // id and tenant id, so this is `undefined` in production.
      //
      // This comment used to read "Production uses a managed identity", which is
      // true of the Graph module and unproven here: a managed identity is an
      // app-only credential, and signing a user in is an authorization-code
      // exchange that Entra expects to carry a client_secret or a
      // client_assertion. Production sign-in has never run - it needs a redirect
      // URI that does not exist yet - so whether this works is an open question,
      // not a settled design. Do NOT resolve it by putting a secret in Azure
      // without reading runbook.md -> "Does production sign-in need the SSO
      // client secret?"; that would breach CLAUDE.md prohibition 7.
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
