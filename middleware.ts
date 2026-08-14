import NextAuth from "next-auth";
import { authConfig } from "./auth.config";

/**
 * Session presence only.
 *
 * The middleware cannot do more than this. It runs on the edge, where Prisma is
 * unreachable, and the token deliberately carries no grants, no admin flag, and
 * no profileCompleted - so every real authorization decision needs a database
 * read and belongs in a Node-runtime layout or route handler.
 *
 * The onboarding redirect lives in app/(platform)/layout.tsx.
 * The module and admin guards live in lib/authz.
 *
 * This is a convenience redirect, not a security boundary.
 */
const { auth: middlewareAuth } = NextAuth(authConfig);

export default middlewareAuth((req) => {
  const signedIn = req.auth !== null;
  const { pathname } = req.nextUrl;

  const isPublic =
    pathname === "/signin" ||
    pathname === "/unauthorized" ||
    pathname.startsWith("/api/auth");

  if (!signedIn && !isPublic) {
    const signInUrl = new URL("/signin", req.nextUrl.origin);
    return Response.redirect(signInUrl);
  }

  return undefined;
});

export const config = {
  // Everything except Next internals and static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|ico)$).*)"],
};
