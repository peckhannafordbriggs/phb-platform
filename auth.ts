import NextAuth from "next-auth";
import { authConfig } from "./auth.config";
import { applyLoginGate } from "@/lib/auth/signin";
import type { TokenClaims } from "@/lib/auth/gate";
import { logger } from "@/lib/logger";

/**
 * Node-runtime Auth.js instance. Imported by route handlers, server components,
 * and the API surface - never by middleware.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
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
