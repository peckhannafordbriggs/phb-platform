import { listGrantedModules, type Viewer } from "@/lib/authz";

/**
 * The single description of "who am I and what can I see".
 *
 * PHASE-1.md requires /api/me to be the only source the sidebar uses. Rather
 * than have a server component fetch its own HTTP endpoint, both the route and
 * the shell call this function - one source of truth, no self-fetch, and no
 * hardcoded module list in either place.
 */

export interface MeModule {
  key: string;
  displayName: string;
  description: string | null;
  icon: string | null;
  sortOrder: number;
}

export interface Me {
  employee: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
  };
  profileCompleted: boolean;
  isPlatformAdmin: boolean;
  /** Active modules this employee holds a grant for, in sidebar order. */
  modules: MeModule[];
  grantedModuleKeys: string[];
}

export async function buildMe(viewer: Viewer): Promise<Me> {
  const modules = await listGrantedModules(viewer.id);

  return {
    employee: {
      id: viewer.id,
      email: viewer.email,
      firstName: viewer.firstName,
      lastName: viewer.lastName,
    },
    profileCompleted: viewer.profileCompleted,
    isPlatformAdmin: viewer.isPlatformAdmin,
    modules,
    grantedModuleKeys: modules.map((m) => m.key),
  };
}
