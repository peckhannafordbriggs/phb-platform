import { z } from "zod";

/**
 * Every admin input is parsed at the boundary. Nothing trusts a client-supplied
 * employee ID, role, or permission - the acting admin always comes from the
 * session, never from the body.
 */

export const employeeStatusSchema = z.enum(["active", "disabled"]);
export const listItemStatusSchema = z.enum(["active", "hidden"]);

export const grantBodySchema = z.object({
  moduleKey: z.string().trim().min(1).max(100),
});

export const statusBodySchema = z.object({
  status: employeeStatusSchema,
});

export const adminFlagBodySchema = z.object({
  isPlatformAdmin: z.boolean(),
});

export const bulkGrantBodySchema = z.object({
  employeeIds: z.array(z.uuid()).min(1).max(500),
  moduleKey: z.string().trim().min(1).max(100),
  action: z.enum(["grant", "revoke"]),
});

/**
 * Bulk enable / disable.
 *
 * PHASE-10 fixes the scope of bulk operations at grants and status, and nothing
 * else. That is why this is its own narrow schema rather than a general
 * "apply a change to many employees" shape - a schema that could express more
 * would be the first step towards a bulk action that sends something, which
 * CLAUDE.md prohibits outright.
 */
export const bulkStatusBodySchema = z.object({
  employeeIds: z.array(z.uuid()).min(1).max(500),
  status: employeeStatusSchema,
});

export const listItemCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
});

export const listItemPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    status: listItemStatusSchema.optional(),
  })
  .refine((v) => v.name !== undefined || v.status !== undefined, {
    message: "Provide a name or a status to change.",
  });

/**
 * Sortable columns.
 *
 * A closed set, not a column name from the query string - a caller-supplied
 * sort field is an injection surface and a way to order by a column the list
 * does not show. PHASE-10 asks for exactly these three.
 */
export const employeeSortSchema = z.enum(["name", "lastLogin", "status"]);
export const sortDirectionSchema = z.enum(["asc", "desc"]);

/** Query parameters arrive as strings; these coerce and bound them. */
export const employeeListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  moduleKey: z.string().trim().max(100).optional(),
  status: employeeStatusSchema.optional(),
  departmentId: z.uuid().optional(),
  /**
   * Default view is employees with at least one grant - the table accumulates
   * everyone who ever signed in, so showing all of them by default is noise.
   *
   * `none` is its own case rather than the absence of a module filter, because
   * "who signed in and never got access" is a question an admin actually asks
   * and cannot express as any combination of the others.
   */
  scope: z.enum(["granted", "all", "none"]).default("granted"),
  sort: employeeSortSchema.default("name"),
  dir: sortDirectionSchema.default("asc"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

export type EmployeeListQuery = z.infer<typeof employeeListQuerySchema>;

/**
 * A date bound from a query string.
 *
 * Accepts what a browser date input sends (`2026-09-12`) as well as a full
 * ISO timestamp. A `yyyy-mm-dd` value is interpreted in UTC, which matches how
 * `occurredAt` is stored - reading it as local time would silently shift the
 * boundary by the timezone offset and drop or include a day's worth of events
 * depending on which side of UTC the reader sits.
 */
const auditDateSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .transform((value, ctx) => {
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value;
    const parsed = new Date(iso);
    if (Number.isNaN(parsed.getTime())) {
      ctx.addIssue({ code: "custom", message: "Not a date." });
      return z.NEVER;
    }
    return parsed;
  });

export const auditQuerySchema = z
  .object({
    targetEmployeeId: z.uuid().optional(),
    actorEmployeeId: z.uuid().optional(),
    action: z.string().trim().max(100).optional(),
    /** Inclusive lower bound. */
    from: auditDateSchema.optional(),
    /**
     * Upper bound, exclusive of nothing - a bare date means "to the end of that
     * day", which is what somebody typing one into a filter means by it.
     */
    to: auditDateSchema.optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })
  .refine((v) => v.from === undefined || v.to === undefined || v.from <= v.to, {
    message: "The start of the range must not be after the end.",
    path: ["from"],
  });

export type AuditQuery = z.infer<typeof auditQuerySchema>;

/** Parses URLSearchParams into a plain object before validation. */
export function searchParamsToObject(
  params: URLSearchParams,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    if (value !== "") out[key] = value;
  }
  return out;
}
