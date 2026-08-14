import { auth } from "@/auth";
import { prisma } from "@/lib/db";

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

/**
 * Checks 1 through 3: authenticated, session not revoked, employee active.
 *
 * Stops short of the profile check, because /api/me and the onboarding
 * submission must both work for someone who has not completed their profile -
 * that is the whole point of onboarding.
 */
export async function requireAuthenticated(): Promise<AccessResult> {
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
