import { redirect } from "next/navigation";
import { requireEmployee } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { ProfileForm } from "./profile-form";

export const dynamic = "force-dynamic";

/**
 * The employee's own profile.
 *
 * Position is the one field they can change. Everything else is shown read-only
 * with a note about who does change it - a disabled input with no explanation
 * reads as a bug, and the honest answer ("your name comes from Microsoft", "an
 * administrator sets your department") is short.
 *
 * Guarded here as well as in the shell. AppShell already redirects an
 * unauthenticated or un-onboarded visitor, but a page that depends on a layout
 * for its authorization is a page that loses it the day the layout changes.
 */
export default async function ProfilePage() {
  const access = await requireEmployee();
  if (!access.ok) {
    if (access.denial === "profile_incomplete") redirect("/onboarding");
    redirect("/signin");
  }

  const [employee, positions] = await Promise.all([
    prisma.employee.findUnique({
      where: { id: access.viewer.id },
      select: {
        email: true,
        firstName: true,
        lastName: true,
        positionId: true,
        positionOther: true,
        position: { select: { name: true, status: true } },
        department: { select: { name: true } },
      },
    }),
    prisma.position.findMany({
      where: { status: "active" },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  // requireEmployee just read this row, so it exists.
  if (employee === null) redirect("/signin");

  return (
    <div className="max-w-2xl">
      <h1 className="text-xl font-semibold">Your profile</h1>
      <p className="mt-1 text-sm text-[var(--muted)]">
        Position is the only field you can change here.
      </p>

      <section className="mt-6 rounded border border-[var(--border)]">
        <h2 className="border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-semibold">
          Set by the company
        </h2>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 px-4 py-4 text-sm">
          <Row label="Name" note="From your Microsoft account.">
            {`${employee.firstName} ${employee.lastName}`.trim()}
          </Row>
          <Row label="Email" note="From your Microsoft account.">
            {employee.email}
          </Row>
          <Row label="Department" note="An administrator sets this.">
            {employee.department?.name ?? "Not set"}
          </Row>
        </dl>
      </section>

      <section className="mt-6 rounded border border-[var(--border)]">
        <h2 className="border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm font-semibold">
          Your position
        </h2>
        <div className="px-4 py-4">
          {employee.position?.status === "hidden" && (
            <p className="mb-3 text-xs italic text-[var(--muted)]">
              Your current position ({employee.position.name}) is no longer on the
              list. Choosing a new one will replace it.
            </p>
          )}
          <ProfileForm
            positions={positions}
            currentPositionId={employee.positionId}
            currentPositionOther={employee.positionOther}
          />
        </div>
      </section>
    </div>
  );
}

function Row({
  label,
  note,
  children,
}: {
  label: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-xs font-medium text-[var(--muted)]">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
      <p className="mt-0.5 text-xs text-[var(--muted)]">{note}</p>
    </div>
  );
}
