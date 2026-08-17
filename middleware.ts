import NextAuth from "next-auth";
import { unauthenticated } from "@/lib/api/response";
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
    // A redirect only helps a browser navigating to a page. An API caller gets
    // the same 401 and the same error shape it would get from the route handler
    // itself - otherwise fetch() follows the redirect and the caller has to
    // parse a sign-in HTML page to discover it is not signed in.
    if (pathname.startsWith("/api/")) return unauthenticated();

    const signInUrl = new URL("/signin", req.nextUrl.origin);
    return Response.redirect(signInUrl);
  }

  return undefined;
});

export const config = {
  // Everything except Next internals and static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|ico)$).*)"],
};
