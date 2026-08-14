import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/authz";
import { listDepartments, listPositions } from "@/lib/admin/service";
import { ListEditor } from "./list-editor";

export const dynamic = "force-dynamic";

export default async function AdminListsPage() {
  const access = await requireAdmin();
  if (!access.ok) notFound();

  const [positions, departments] = await Promise.all([
    listPositions(true),
    listDepartments(true),
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
      <p className="mt-2 text-sm text-[var(--muted)]">
        Hiding a value removes it from the onboarding dropdowns. Employees
        already assigned to it keep it — nothing is deleted.
      </p>

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
