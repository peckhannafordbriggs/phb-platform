import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/authz";
import {
  freeTextPositionCount,
  listDepartmentsWithCounts,
  listPositionsWithCounts,
} from "@/lib/admin/service";
import { ListEditor } from "./list-editor";

export const dynamic = "force-dynamic";

export default async function AdminListsPage() {
  const access = await requireAdmin();
  if (!access.ok) notFound();

  const [positions, departments, freeText] = await Promise.all([
    listPositionsWithCounts(true),
    listDepartmentsWithCounts(true),
    freeTextPositionCount(),
  ]);

  return (
    <div className="max-w-3xl">
      <Link
        href="/admin"
        className="text-sm text-[var(--accent)] underline underline-offset-2"
      >
        ← All employees
      </Link>

      <h1 className="mt-4 text-xl font-semibold">Positions &amp; departments</h1>
      <p className="mt-2 max-w-2xl text-sm text-[var(--muted)]">
        Hiding a value removes it from the dropdowns and refuses any new
        assignment to it. Employees already assigned keep it, and it still shows
        on their record — nothing is deleted, and there is no way to delete.
        The number beside each value is how many employees hold it, including
        disabled ones.
      </p>

      {freeText > 0 && (
        <p className="mt-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {freeText} {freeText === 1 ? "employee has" : "employees have"} a
          free-text position rather than one from this list. Onboarding flags
          those for cleanup; adding the value here and reassigning them is the fix.
        </p>
      )}

      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <ListEditor title="Positions" endpoint="positions" items={positions} />
        <ListEditor
          title="Departments"
          endpoint="departments"
          items={departments}
        />
      </div>
    </div>
  );
}
