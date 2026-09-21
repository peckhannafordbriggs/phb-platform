import { headers } from "next/headers";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { recordActivity } from "@/lib/activity/record";
import { isStampedPageRequest } from "@/lib/activity/rollover";

/**
 * The authorization boundary. Every module route and every module page goes
 * through here; nothing reimplements these checks.
 *
 * Grants are read from the database on every call. There is no cache in Phase 1
 * - at this user count a cache buys nothing and is one more reason a revocation
 * could appear not to have worked.
 *
 * The result is a denial code rather than an HTTP response so that pages and
 * API routes can share the same logic. Only the API layer maps it to a status.
 */

export type Denial =
  | "unauthenticated"
  | "session_expired"
  | "employee_inactive"
  | "profile_incomplete"
  | "no_grant"
  | "not_module_admin"
  | "not_admin";

export interface Viewer {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  profileCompleted: boolean;
  isPlatformAdmin: boolean;
}

export type AccessResult =
  | { ok: true; viewer: Viewer }
  | { ok: false; denial: Denial };

export interface AuthenticatedOptions {
  /**
   * Whether a successful check may count as "this person was here".
   * Defaults to true. ONE caller passes false: the shared shell. See the
   * activity note inside requireAuthenticated for why it is that caller and
   * no other.
   */
  recordActivity?: boolean;
}

/**
 * Checks 1 through 3: authenticated, session not revoked, employee active.
 *
 * Stops short of the profile check, because /api/me and the onboarding
 * submission must both work for someone who has not completed their profile -
 * that is the whole point of onboarding.
 */
export async function requireAuthenticated(
  options: AuthenticatedOptions = {},
): Promise<AccessResult> {
  const session = await auth();

  if (session === null || session.entraOid === null) {
    return { ok: false, denial: "unauthenticated" };
  }

  const employee = await prisma.employee.findUnique({
    where: { entraOid: session.entraOid },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      status: true,
      profileCompleted: true,
      isPlatformAdmin: true,
      sessionsValidAfter: true,
      // Read here because this lookup happens anyway. See the activity note
      // below the checks.
      lastActiveAt: true,
      previousActiveAt: true,
    },
  });

  if (employee === null) {
    return { ok: false, denial: "unauthenticated" };
  }

  // A session issued before sessionsValidAfter is rejected. Fail closed: a
  // token with no readable issue time cannot be shown to be recent enough.
  if (employee.sessionsValidAfter !== null) {
    if (session.issuedAt === null) {
      return { ok: false, denial: "session_expired" };
    }
    if (session.issuedAt * 1000 < employee.sessionsValidAfter.getTime()) {
      return { ok: false, denial: "session_expired" };
    }
  }

  if (employee.status !== "active") {
    return { ok: false, denial: "employee_inactive" };
  }

  /**
   * ACTIVITY, recorded here and nowhere else.
   *
   * "When was this person last here" is what Home's greeting and digest are
   * dated from (lib/activity/rollover.ts), and it has to mean deliberate page
   * loads and navigations - not the minute-by-minute polling three screens do
   * while their tab is open, and not a `<Link>` prefetch. Two conditions,
   * and each excludes one of those:
   *
   *   1. The middleware stamped this request as a request for a PAGE. Polls
   *      go to API routes; the stamp is the pathname, which a render cannot
   *      see and the middleware can. Nothing else about the request is
   *      usable - Next hides its own router headers from both the middleware
   *      and the render, so "is this a prefetch" cannot be read anywhere.
   *
   *   2. The caller did not opt out. A prefetch renders nothing unless a
   *      `loading.tsx` sits below it, and where one does the render stops AT
   *      that boundary - layouts above run, the page does not. So the only
   *      component a prefetch reaches is the shared shell, and the shell
   *      passes `recordActivity: false`. Every page calls a guard of its own,
   *      because that is the authorization contract, and those calls record.
   *      A shell hook alone would ALSO have missed navigations - a shared
   *      layout is not re-rendered between two pages beneath it - so the
   *      page-level call is the right one twice over.
   *
   * After the checks, deliberately: a rejected request is not a visit.
   *
   * A side effect in an authorization function is not a pattern to copy. It
   * is here because the alternative is a fact that silently goes stale, and
   * it is bounded: one conditional UPDATE, a few times a day, that can fail
   * without failing the request.
   */
  if (options.recordActivity !== false && (await isPageRequestStamped())) {
    await recordActivity({
      id: employee.id,
      lastActiveAt: employee.lastActiveAt,
      previousActiveAt: employee.previousActiveAt,
    });
  }

  const viewer: Viewer = {
    id: employee.id,
    email: employee.email,
    firstName: employee.firstName,
    lastName: employee.lastName,
    profileCompleted: employee.profileCompleted,
    isPlatformAdmin: employee.isPlatformAdmin,
  };

  return { ok: true, viewer };
}

/**
 * Whether the middleware stamped this request as one for a page.
 *
 * Read from the stamp middleware.ts writes (PAGE_REQUEST_HEADER in
 * lib/activity/rollover.ts). A render's `headers()` cannot see the pathname
 * and never sees Next's router headers, so the middleware's answer is the
 * only one available here.
 *
 * `headers()` throws outside a request scope - a test calling a route handler
 * directly, a script - and that is "no", not an error: nothing was navigated
 * to.
 */
async function isPageRequestStamped(): Promise<boolean> {
  try {
    return isStampedPageRequest(await headers());
  } catch {
    return false;
  }
}

/**
 * Checks 1 through 4 of the order in PHASE-1.md - everything except the grant.
 * This is the baseline for any route that is not part of onboarding.
 */
export async function requireEmployee(): Promise<AccessResult> {
  const base = await requireAuthenticated();
  if (!base.ok) return base;

  if (!base.viewer.profileCompleted) {
    return { ok: false, denial: "profile_incomplete" };
  }

  return base;
}

/**
 * The full check for a module route. A missing grant is reported as no_grant,
 * which the API layer renders as 404 - the platform does not confirm that a
 * module exists to someone who cannot use it.
 */
export async function requireModuleAccess(
  moduleKey: string,
): Promise<AccessResult> {
  const base = await requireEmployee();
  if (!base.ok) return base;

  const grant = await prisma.moduleGrant.findUnique({
    where: {
      employeeId_moduleKey: { employeeId: base.viewer.id, moduleKey },
    },
    select: { id: true, module: { select: { status: true } } },
  });

  // A hidden module is not reachable even by someone holding a grant.
  if (grant === null || grant.module.status !== "active") {
    return { ok: false, denial: "no_grant" };
  }

  return base;
}

/**
 * The full check for a module's ADMINISTRATIVE surface - for `bas`, the
 * Settings tab (B7.2).
 *
 * Two things this is not.
 *
 * It is not `requireAdmin`. `isPlatformAdmin` is the person who grants module
 * access and disables employees; this is someone who may change what one module
 * collects. Jake can be trusted to add a building without being trusted to
 * remove Jake's colleagues. Deliberately no `isPlatformAdmin` branch here: a
 * platform admin has no implicit module access anywhere else in this file
 * either, and making the admin surface the one exception would mean the audit
 * row "granted BAS admin to Jake" no longer describes everyone who can add a
 * building.
 *
 * It is not a second grant to look up. `isModuleAdmin` is a column on the grant
 * row, so no grant means no admin rights, and revoking access revokes them too.
 *
 * `not_module_admin` maps to 404, exactly like `no_grant`. An administrative
 * surface is a surface, and the platform does not confirm to someone who cannot
 * use it that one exists.
 */
export async function requireModuleAdmin(
  moduleKey: string,
): Promise<AccessResult> {
  const base = await requireModuleAccess(moduleKey);
  if (!base.ok) return base;

  if (!(await hasModuleAdmin(base.viewer.id, moduleKey))) {
    return { ok: false, denial: "not_module_admin" };
  }

  return base;
}

/**
 * The flag on its own, for a caller that has already passed
 * `requireModuleAccess` and only needs to know whether to render something.
 *
 * Exists so the tab bar can hide Settings without paying for the whole chain a
 * second time, and so the rule "the grant row carries the flag" is written once
 * rather than in every page that wants to know.
 *
 * NOT a security boundary and never to be used as one. Hiding a tab is not
 * authorization (docs/04); the page behind it calls `requireModuleAdmin` and so
 * does every route it fetches.
 */
export async function hasModuleAdmin(
  employeeId: string,
  moduleKey: string,
): Promise<boolean> {
  const grant = await prisma.moduleGrant.findUnique({
    where: { employeeId_moduleKey: { employeeId, moduleKey } },
    select: { isModuleAdmin: true },
  });

  return grant?.isModuleAdmin === true;
}

/**
 * Admin is not a module, so a non-admin gets 403 rather than the 404 used for
 * missing module grants. Every /api/admin/* route calls this independently.
 */
export async function requireAdmin(): Promise<AccessResult> {
  const base = await requireEmployee();
  if (!base.ok) return base;

  if (!base.viewer.isPlatformAdmin) {
    return { ok: false, denial: "not_admin" };
  }

  return base;
}

/** Drives the sidebar and /api/me. Never a hardcoded list. */
export async function listGrantedModules(employeeId: string) {
  const grants = await prisma.moduleGrant.findMany({
    where: { employeeId, module: { status: "active" } },
    select: {
      module: {
        select: {
          key: true,
          displayName: true,
          description: true,
          icon: true,
          sortOrder: true,
        },
      },
    },
    orderBy: { module: { sortOrder: "asc" } },
  });

  return grants.map((g) => g.module);
}
