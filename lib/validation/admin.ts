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

/** Query parameters arrive as strings; these coerce and bound them. */
export const employeeListQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  moduleKey: z.string().trim().max(100).optional(),
  status: employeeStatusSchema.optional(),
  departmentId: z.uuid().optional(),
  // Default view is employees with at least one grant - the table accumulates
  // everyone who ever signed in, so showing all of them by default is noise.
  scope: z.enum(["granted", "all"]).default("granted"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

export type EmployeeListQuery = z.infer<typeof employeeListQuerySchema>;

export const auditQuerySchema = z.object({
  targetEmployeeId: z.uuid().optional(),
  actorEmployeeId: z.uuid().optional(),
  action: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
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
