import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { unauthenticated } from "@/lib/api/response";
import { stampPageRequest } from "@/lib/activity/rollover";
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
 *
 * ONE more thing happens here, and it is here only because nowhere else can
 * see what it needs: every request that goes through is forwarded with
 * `x-phb-page-request` set or removed, saying whether this is a request for a
 * page rather than an API route. The guard reads that to record "when was
 * this person last here" (lib/activity/rollover.ts) - a page's `headers()`
 * cannot see the pathname, and API routes are where every background poll
 * goes. `lib/activity/rollover.ts` has no imports and is edge-safe.
 */
const { auth: middlewareAuth } = NextAuth(authConfig);

export default middlewareAuth((req) => {
  const signedIn = req.auth !== null;
  const { pathname } = req.nextUrl;

  const isPublic =
    pathname === "/signin" ||
    pathname === "/unauthorized" ||
    pathname.startsWith("/api/auth") ||
    // The container probe. Container Apps sends no cookie, so anything other
    // than a 2xx here reads as "this replica is dead" and it restarts a process
    // that was working. The endpoint itself reports nothing but up/down.
    pathname === "/api/health";

  if (!signedIn && !isPublic) {
    // A redirect only helps a browser navigating to a page. An API caller gets
    // the same 401 and the same error shape it would get from the route handler
    // itself - otherwise fetch() follows the redirect and the caller has to
    // parse a sign-in HTML page to discover it is not signed in.
    if (pathname.startsWith("/api/")) return unauthenticated();

    const signInUrl = new URL("/signin", req.nextUrl.origin);
    return Response.redirect(signInUrl);
  }

  // Forward the request with the page stamp written in. Always written, so a
  // client cannot supply its own answer.
  return NextResponse.next({
    request: { headers: stampPageRequest(pathname, req.headers) },
  });
});

export const config = {
  // Everything except Next internals and static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|ico)$).*)"],
};
