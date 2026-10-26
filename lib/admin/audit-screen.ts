import type { AuditAction } from "@/lib/audit";

/**
 * What the audit log SCREEN shows. Not what it records.
 *
 * Decided 2026-10-26: the admin screens answer one question - who has an
 * account, who can get into which module, and who changed that - so the audit
 * page and the History panel on an employee's page show only the account and
 * access events:
 *
 *   - account created (first sign-in)
 *   - module access granted or revoked, including module-admin rights
 *   - platform admin added or removed
 *   - account disabled or re-enabled
 *
 * Everything else is still written to `audit_events` exactly as before and is
 * read with SQL (`runbook.md` -> *Who sent a message, and when*; *Who moved,
 * deleted or attached*; *Analyze: reading the log of questions*). `mail.sent`
 * in particular is the only record anywhere of which PERSON sent a vendor
 * email, because the mail app sends as itself - hiding it from a screen is
 * fine, not recording it is not. Nothing in `lib/audit.ts` reads this list,
 * and `tests/audit-screen-scope.test.ts` holds that to the source text.
 *
 * This is a display rule, the same class as `is_visible` on a BAS point: the
 * service applies it to every reader behind the two screens, so the dropdown
 * cannot offer an action the list would never show, and the person filters
 * cannot offer somebody whose only rows are hidden.
 */
export const SCREEN_AUDIT_ACTIONS = [
  "employee.provisioned",
  "grant.added",
  "grant.removed",
  "grant.admin_added",
  "grant.admin_removed",
  "employee.admin_granted",
  "employee.admin_revoked",
  "employee.disabled",
  "employee.enabled",
] as const satisfies readonly AuditAction[];

export type ScreenAuditAction = (typeof SCREEN_AUDIT_ACTIONS)[number];

export function isShownOnAuditScreen(action: string): action is ScreenAuditAction {
  return (SCREEN_AUDIT_ACTIONS as readonly string[]).includes(action);
}

/**
 * The actions a request may see, as the `IN` list for the query.
 *
 * No filter means the whole shown set. A single action is itself when it is
 * shown and nothing when it is not - a hand-edited URL asking for `mail.sent`
 * gets an empty page, never the rows. A group (`cip.*`, from
 * `auditActionFilterOptions`) is the shown actions with that prefix, which is
 * today none of them. An empty array is a valid Prisma `in` and matches no row.
 */
export function screenActionsFor(requested: string | undefined): ScreenAuditAction[] {
  if (requested === undefined || requested.length === 0) return [...SCREEN_AUDIT_ACTIONS];
  if (requested.endsWith(".*")) {
    const prefix = requested.slice(0, -1);
    return SCREEN_AUDIT_ACTIONS.filter((a) => a.startsWith(prefix));
  }
  return isShownOnAuditScreen(requested) ? [requested] : [];
}
