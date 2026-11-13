import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { listDepartments, listEmployees } from "@/lib/admin/service";
import {
  employeeListQuerySchema,
  type EmployeeListQuery,
} from "@/lib/validation/admin";
import { buildInviteEmail } from "@/lib/admin/invite-email";
import { AdminActions, AdminShell } from "./admin-shell";
import { EmployeesView, type EmployeeFilters } from "./employee-table";

export const dynamic = "force-dynamic";

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // The page is guarded server-side. Hiding the sidebar item is not protection.
  const access = await requireAdmin();
  if (!access.ok) notFound();

  const raw = await searchParams;
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const v = Array.isArray(value) ? value[0] : value;
    if (v !== undefined && v !== "") flat[key] = v;
  }

  const parsed = employeeListQuerySchema.safeParse(flat);
  const query: EmployeeListQuery = parsed.success
    ? parsed.data
    : employeeListQuerySchema.parse({});

  /**
   * Whether the view is narrowed at all.
   *
   * Everyone is the default since 2026-11-13, so the default view is no
   * longer a filter; "With a grant" and "No grants at all" still are, and so
   * is anything typed or picked. An empty screen on a fresh platform and an
   * empty screen because a filter hid everybody are different problems.
   */
  const filtered =
    flat.q !== undefined ||
    flat.moduleKey !== undefined ||
    flat.status !== undefined ||
    flat.departmentId !== undefined ||
    query.scope !== "all";

  const [result, departments, modules] = await Promise.all([
    listEmployees(query),
    listDepartments(false),
    prisma.module.findMany({
      where: { status: "active" },
      select: { key: true, displayName: true },
      orderBy: { sortOrder: "asc" },
    }),
  ]);

  const applied: EmployeeFilters = {
    q: query.q ?? "",
    moduleKey: query.moduleKey ?? "",
    status: query.status ?? "",
    departmentId: query.departmentId ?? "",
    scope: query.scope,
  };

  return (
    <AdminShell actions={<AdminActions email={buildInviteEmail()} />}>
      <EmployeesView
        /*
          Keyed on the applied query, so a navigation - Apply, Reset, a sort,
          a page, the browser's Back - remounts the view with the drafted
          filters equal to the applied ones. A refresh after a grant toggle
          changes no parameter and keeps the view's state: the expanded rows
          and the selection stay where they were.
        */
        key={JSON.stringify({ applied, sort: query.sort, dir: query.dir, page: query.page })}
        employees={result.employees}
        modules={modules}
        departments={departments.map((d) => ({ id: d.id, name: d.name }))}
        applied={applied}
        sort={query.sort}
        dir={query.dir}
        page={result.page}
        pageSize={result.pageSize}
        total={result.total}
        employeesTotal={result.employeesTotal}
        totalPages={result.totalPages}
        filtered={filtered}
      />
    </AdminShell>
  );
}
