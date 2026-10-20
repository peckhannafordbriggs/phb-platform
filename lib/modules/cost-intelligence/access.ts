import { prisma } from "@/lib/db";
import { COST_INTELLIGENCE_MODULE_KEY } from "./constants";
import type { Permission, Role, RoleId } from "./types";

/**
 * Who can use Cost Intelligence, and what each role means.
 *
 * Roles are the platform's own grant, not a table of ours: a Cost Intelligence
 * grant makes you a Member, and the grant's "Can change settings" flag
 * (is_module_admin) makes you a PCE. Both are set by platform admins in /admin,
 * which writes the audit rows. Nothing in this file writes.
 */

export const CIP_ROLES: Role[] = [
  { id: "pce", name: "PCE" },
  { id: "member", name: "Member" },
];

/** Fixed in code. The Access page shows this table read-only. */
export const CIP_PERMISSIONS: Permission[] = [
  { label: "View runs and outputs", roles: ["pce", "member"] },
  { label: "Start runs", roles: ["pce", "member"] },
  { label: "Answer run decisions", roles: ["pce", "member"] },
  { label: "Open Settings", roles: ["pce"] },
  { label: "Sync the skill catalog", roles: ["pce"] },
  { label: "Manage workflows", roles: ["pce"] },
  { label: "See access and budget", roles: ["pce"] },
];

export type CipMember = {
  id: string;
  name: string;
  email: string;
  role: RoleId;
  lastActiveAt: Date | null;
};

/** Active employees with a Cost Intelligence grant. PCEs first, then by name. */
export async function listCipMembers(): Promise<CipMember[]> {
  const grants = await prisma.moduleGrant.findMany({
    where: { moduleKey: COST_INTELLIGENCE_MODULE_KEY, employee: { status: "active" } },
    select: {
      isModuleAdmin: true,
      employee: { select: { id: true, firstName: true, lastName: true, email: true, lastActiveAt: true } },
    },
  });

  return grants
    .map(({ isModuleAdmin, employee }) => ({
      id: employee.id,
      name: `${employee.firstName} ${employee.lastName}`.trim() || employee.email,
      email: employee.email,
      role: (isModuleAdmin ? "pce" : "member") as RoleId,
      lastActiveAt: employee.lastActiveAt,
    }))
    .sort((a, b) =>
      a.role === b.role ? a.name.localeCompare(b.name) || a.id.localeCompare(b.id) : a.role === "pce" ? -1 : 1,
    );
}
