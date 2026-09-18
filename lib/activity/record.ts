import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import {
  planActivityWrite,
  type ActivityRow,
  type ActivityWrite,
} from "./rollover";

/**
 * Apply a deliberate action to an employee's two activity columns.
 *
 * The decision is `planActivityWrite`; this is the write. The caller has
 * already read the row - the authorization guard selects both columns as part
 * of the lookup it does anyway - so this costs nothing until a write is due,
 * and a write is due a few times a day.
 *
 * The UPDATE is conditional on `lastActiveAt` still holding the value that
 * was read. Two tabs loading at once at the start of a day both read
 * yesterday's value and both plan the same rollover; the first wins and the
 * second matches zero rows and leaves it, rather than rolling the anchor a
 * second time onto today's value. A matched-zero-rows outcome is not an error
 * and is not logged.
 *
 * A failure here is logged and swallowed. The guard calls this on the way to
 * rendering a page, and a broken activity write must never cost the page: the
 * anchor being a day stale is a nuisance, an unreachable platform is not.
 *
 * Returns the plan so a test can assert on what was decided as well as on
 * the row, and null when nothing was written.
 */
export async function recordActivity(
  employee: ActivityRow & { id: string },
  now: Date = new Date(),
): Promise<ActivityWrite | null> {
  const plan = planActivityWrite(employee, now);
  if (plan === null) return null;

  try {
    await prisma.employee.updateMany({
      where: { id: employee.id, lastActiveAt: employee.lastActiveAt },
      data: {
        lastActiveAt: plan.lastActiveAt,
        previousActiveAt: plan.previousActiveAt,
      },
    });
  } catch (error) {
    logger.warn("activity.record_failed", {
      employeeId: employee.id,
      outcome: "skipped",
      reason: error instanceof Error ? error.message : "unknown",
    });
    return null;
  }

  return plan;
}
