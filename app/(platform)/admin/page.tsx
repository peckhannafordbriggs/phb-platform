import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { listDepartments, listEmployees } from "@/lib/admin/service";
import {
  employeeListQuerySchema,
  type EmployeeListQuery,
} from "@/lib/validation/admin";
import { EmployeeTable } from "./employee-table";

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
   * The default scope counts: "With a grant" hides everyone who signed in and
   * never got access, which is a filter even though nobody chose it. An empty
   * screen on a fresh platform and an empty screen because the default hid
   * everybody are different problems.
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

  return (
    <div>
      <header className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">Admin</h1>
        <nav className="flex items-baseline gap-4 text-sm">
          <Link
            href="/admin/audit"
            className="text-[var(--accent)] underline underline-offset-2"
          >
            Audit log
          </Link>
          <Link
            href="/admin/lists"
            className="text-[var(--accent)] underline underline-offset-2"
          >
            Positions &amp; departments
          </Link>
        </nav>
      </header>

      <p className="mt-2 text-sm text-[var(--muted)]">
        Everyone who has ever signed in appears here. Granting a module is what
        gives access; there is no way to create an employee.
      </p>

      <form method="GET" className="mt-6 flex flex-wrap items-end gap-3">
        <Labelled label="Search">
          <input
            name="q"
            defaultValue={query.q ?? ""}
            placeholder="Name or email"
            className="w-56 rounded border border-[var(--border)] px-3 py-1.5 text-sm"
          />
        </Labelled>

        <Labelled label="Module">
          <select
            name="moduleKey"
            defaultValue={query.moduleKey ?? ""}
            className="rounded border border-[var(--border)] bg-white px-3 py-1.5 text-sm"
          >
            <option value="">Any</option>
            {modules.map((m) => (
              <option key={m.key} value={m.key}>
                {m.displayName}
              </option>
            ))}
          </select>
        </Labelled>

        <Labelled label="Status">
          <select
            name="status"
            defaultValue={query.status ?? ""}
            className="rounded border border-[var(--border)] bg-white px-3 py-1.5 text-sm"
          >
            <option value="">Any</option>
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
          </select>
        </Labelled>

        <Labelled label="Department">
          <select
            name="departmentId"
            defaultValue={query.departmentId ?? ""}
            className="rounded border border-[var(--border)] bg-white px-3 py-1.5 text-sm"
          >
            <option value="">Any</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </Labelled>

        <Labelled label="Show">
          <select
            name="scope"
            defaultValue={query.scope}
            className="rounded border border-[var(--border)] bg-white px-3 py-1.5 text-sm"
          >
            <option value="granted">With a grant</option>
            <option value="all">Everyone</option>
            {/*
              Its own case, not the absence of a module filter. "Who signed in
              and never got access" is a question an admin actually asks and
              cannot express as any combination of the other filters.
            */}
            <option value="none">No grants at all</option>
          </select>
        </Labelled>

        {/* Sorting travels in the URL like everything else, so a sorted view is
            bookmarkable and survives Apply. */}
        <input type="hidden" name="sort" value={query.sort} />
        <input type="hidden" name="dir" value={query.dir} />

        <button
          type="submit"
          className="rounded bg-[var(--accent)] px-4 py-1.5 text-sm font-medium text-white"
        >
          Apply
        </button>
        <Link
          href="/admin"
          className="px-2 py-1.5 text-sm text-[var(--muted)] underline underline-offset-2"
        >
          Reset
        </Link>
      </form>

      <EmployeeTable
        employees={result.employees}
        modules={modules}
        page={result.page}
        pageSize={result.pageSize}
        total={result.total}
        employeesTotal={result.employeesTotal}
        totalPages={result.totalPages}
        sort={query.sort}
        dir={query.dir}
        filtered={filtered}
      />
    </div>
  );
}

function Labelled({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-[var(--muted)]">
        {label}
      </span>
      {children}
    </label>
  );
}
