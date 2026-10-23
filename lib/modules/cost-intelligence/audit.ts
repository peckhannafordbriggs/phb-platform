import { writeAuditEvent, type AuditAction } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { logUnexpected } from "@/lib/logger";
import { COST_INTELLIGENCE_MODULE_KEY } from "./constants";

type CipAction = Extract<AuditAction, `cip.${string}`>;

/** Long agent errors stay readable in the audit list; the run ledger keeps the rest. */
const ERROR_MAX = 500;

/**
 * Records a Cost Intelligence outcome in audit_events. Never throws: the run or
 * request has already reached that outcome, and losing it because the audit
 * write failed would be worse than a missing row, which is logged instead.
 * A null actor is the platform (the worker), not a person.
 */
export async function cipAudit(
  action: CipAction,
  actorEmployeeId: string | null,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await writeAuditEvent(prisma, { action, actorEmployeeId, moduleKey: COST_INTELLIGENCE_MODULE_KEY, metadata });
  } catch (error) {
    logUnexpected("cip.audit_write_failed", error, { reason: action, moduleKey: COST_INTELLIGENCE_MODULE_KEY });
  }
}

/** An error, cut to a length the audit list can show. */
export function auditError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > ERROR_MAX ? `${text.slice(0, ERROR_MAX)}...` : text;
}

/** An unexpected error in a Cost Intelligence API route: logged, and recorded for the audit page. */
export async function cipRequestFailed(
  operation: string,
  error: unknown,
  fields: { route: string; employeeId: string },
): Promise<void> {
  logUnexpected(operation, error, fields);
  await cipAudit("cip.request_failed", fields.employeeId, { operation, route: fields.route, error: auditError(error) });
}
