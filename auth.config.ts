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
      // Local development only. Production uses a managed identity.
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
