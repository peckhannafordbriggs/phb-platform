import NextAuth from "next-auth";
import { authConfig } from "./auth.config";
import { buildEntraProvider, secretOrNull } from "@/lib/auth/entra-provider";
import { applyLoginGate } from "@/lib/auth/signin";
import type { TokenClaims } from "@/lib/auth/gate";
import { env, isProduction } from "@/lib/env";
import { logger } from "@/lib/logger";

/**
 * Node-runtime Auth.js instance. Imported by route handlers, server components,
 * and the API surface - never by middleware.
 *
 * The provider is rebuilt here rather than taken from auth.config.ts: in
 * production it carries the managed-identity assertion, which needs
 * @azure/identity and so cannot live in the edge-safe config the middleware
 * imports. See lib/auth/entra-provider.ts. Building it at module load is what
 * makes a secret in production a refusal to boot rather than a surprise later.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    buildEntraProvider({
      clientId: env.AUTH_MICROSOFT_ENTRA_ID_ID,
      tenantId: env.AUTH_MICROSOFT_ENTRA_ID_TENANT_ID,
      clientSecret: secretOrNull(env.AUTH_MICROSOFT_ENTRA_ID_SECRET),
      production: isProduction,
      // The platform's one user-assigned identity. The variable is named for
      // the module that first needed it; sign-in uses the same identity.
      managedIdentityClientId: secretOrNull(process.env.GRAPH_MANAGED_IDENTITY_CLIENT_ID),
    }),
  ],
  callbacks: {
    /**
     * The four-check login gate. Returning false sends the browser to
     * /unauthorized with no detail about which check failed.
     */
    async signIn({ profile }) {
      if (profile === undefined || profile === null) {
        logger.warn("signin.no_profile", {
          outcome: "denied",
          reason: "missing_claims",
        });
        return false;
      }

      const outcome = await applyLoginGate(profile as TokenClaims);

      if (!outcome.ok) {
        // The reason is recorded in the audit event and the server log. It is
        // never shown to the person being rejected.
        logger.warn("signin.denied", {
          outcome: "denied",
          reason: outcome.reason,
        });
        return false;
      }

      logger.info("signin.allowed", {
        outcome: "allowed",
        employeeId: outcome.employeeId,
      });
      return true;
    },

    /**
     * The token carries the Entra object ID and nothing else that authorizes
     * anything. No grants, no admin flag, no employee row contents.
     */
    async jwt({ token, profile }) {
      if (profile !== undefined && profile !== null) {
        const oid = (profile as TokenClaims).oid;
        if (typeof oid === "string" && oid.length > 0) {
          token.entraOid = oid;
        }
      }
      return token;
    },

    async session({ session, token }) {
      const entraOid: unknown = token.entraOid;
      session.entraOid = typeof entraOid === "string" ? entraOid : null;
      // Used by the guard to reject sessions issued before sessionsValidAfter.
      session.issuedAt = typeof token.iat === "number" ? token.iat : null;
      return session;
    },
  },
});
