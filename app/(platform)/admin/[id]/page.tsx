import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { getEmployeeDetail, moduleDisplayNames } from "@/lib/admin/service";
import { AuditList } from "../audit-list";
import { EmployeeControls } from "./employee-controls";
import { ProfileControls } from "./profile-controls";

export const dynamic = "force-dynamic";

export default async function AdminEmployeePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const access = await requireAdmin();
  if (!access.ok) notFound();

  const { id } = await params;
  const employee = await getEmployeeDetail(id);
  if (employee === null) notFound();

  const [modules, positions, departments, moduleNames] = await Promise.all([
    prisma.module.findMany({
      where: { status: "active" },
      select: { key: true, displayName: true },
      orderBy: { sortOrder: "asc" },
    }),
    // Hidden values are omitted, so an admin cannot assign one either. Existing
    // assignments to a hidden value are preserved and labelled below.
    prisma.position.findMany({
      where: { status: "active" },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.department.findMany({
      where: { status: "active" },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    moduleDisplayNames(),
  ]);

  const grantedKeys = employee.grants.map((g) => g.moduleKey);

  return (
    <div className="max-w-3xl">
      <Link
        href="/admin"
        className="text-sm text-[var(--accent)] underline underline-offset-2"
      >
        ← All employees
      </Link>

      <h1 className="mt-4 text-xl font-semibold">
        {employee.firstName} {employee.lastName}
      </h1>
      <p className="text-sm text-[var(--muted)]">{employee.email}</p>

      <section className="mt-6 rounded border border-[var(--border)]">
        <h2 className="border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-semibold">
          Profile
        </h2>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 px-4 py-4 text-sm">
          <Row label="Position (self-reported)">
            {employee.position?.name ?? employee.positionOther ?? "—"}
            {employee.positionOther !== null && (
              <span className="ml-2 text-xs italic text-[var(--muted)]">
                free text — needs cleanup
              </span>
            )}
            {employee.position?.status === "hidden" && (
              <span className="ml-2 text-xs italic text-[var(--muted)]">
                hidden value
              </span>
            )}
          </Row>
          <Row label="Department">
            {employee.department?.name ?? "—"}
            {employee.department?.status === "hidden" && (
              <span className="ml-2 text-xs italic text-[var(--muted)]">
                hidden value
              </span>
            )}
          </Row>
          <Row label="Profile completed">
            {employee.profileCompleted ? "Yes" : "No"}
          </Row>
          <Row label="First seen">{formatDate(employee.firstSeenAt)}</Row>
          <Row label="Last sign-in">{formatDate(employee.lastLoginAt)}</Row>
        </dl>
      </section>

      <ProfileControls
        employeeId={employee.id}
        positions={positions}
        departments={departments}
        currentPositionId={employee.position?.id ?? null}
        currentPositionOther={employee.positionOther}
        currentDepartmentId={employee.department?.id ?? null}
      />

      <EmployeeControls
        employeeId={employee.id}
        isSelf={employee.id === access.viewer.id}
        status={employee.status}
        isPlatformAdmin={employee.isPlatformAdmin}
        modules={modules}
        grantedModuleKeys={grantedKeys}
      />

      {/*
        PHASE-10: "the common question is 'why does this person have access' and
        it should be answerable without leaving the page." So the history is
        inline and readable, rendered by the same describeAuditEvent the audit
        page uses rather than by a second, narrower renderer here - which is
        what this section used to be, printing `grant.added` and two emails.
      */}
      <section className="mt-6 rounded border border-[var(--border)]">
        <h2 className="flex items-baseline justify-between border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-semibold">
          <span>History</span>
          <Link
            href={`/admin/audit?targetEmployeeId=${employee.id}`}
            className="text-xs font-normal text-[var(--accent)] underline underline-offset-2"
          >
            Open in the audit log
          </Link>
        </h2>
        <AuditList
          events={employee.auditHistory}
          moduleNames={moduleNames}
          // Every row here is about this person; repeating the name would be noise.
          hideTarget
          emptyMessage="Nothing has been recorded for this employee yet."
        />
        {employee.auditHistory.length === 100 && (
          <p className="border-t border-[var(--border)] px-4 py-2 text-xs text-[var(--muted)]">
            Showing the 100 most recent events. The audit log has the rest.
          </p>
        )}
      </section>
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-xs font-medium text-[var(--muted)]">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

function formatDate(value: Date | null): string {
  if (value === null) return "Never";
  return value.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

