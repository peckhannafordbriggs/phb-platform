import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/authz";
import {
  auditFilterOptions,
  listAuditEvents,
  moduleDisplayNames,
} from "@/lib/admin/service";
import { knownAuditActions } from "@/lib/admin/audit-describe";
import { auditQuerySchema } from "@/lib/validation/admin";
import { AuditList } from "../audit-list";

export const dynamic = "force-dynamic";

/**
 * The audit log, readable.
 *
 * PHASE-10 calls this the point of the phase, and the reason is narrow: under
 * app-only Graph auth Exchange records the *application* as having sent a
 * message, not the person. For anything touching mail, these rows are the only
 * record of who did it. They have been written correctly since Phase 3 and had
 * no reader until now.
 *
 * Read-only, and structurally so. There is no PATCH or DELETE route behind this
 * page, and the database trigger rejects both regardless — see the
 * audit_append_only migration.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await requireAdmin();
  if (!access.ok) notFound();

  const raw = await searchParams;
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const v = Array.isArray(value) ? value[0] : value;
    if (v !== undefined && v !== "") flat[key] = v;
  }

  const parsed = auditQuerySchema.safeParse(flat);
  // A malformed filter falls back to the unfiltered view and says so, rather
  // than 500-ing on a hand-edited URL.
  const query = parsed.success ? parsed.data : auditQuerySchema.parse({});
  const filterError = parsed.success
    ? null
    : (parsed.error.issues[0]?.message ?? "Those filters are not valid.");

  const [result, options, moduleNames] = await Promise.all([
    listAuditEvents(query),
    auditFilterOptions(),
    moduleDisplayNames(),
  ]);

  const filtered =
    flat.targetEmployeeId !== undefined ||
    flat.actorEmployeeId !== undefined ||
    flat.action !== undefined ||
    flat.from !== undefined ||
    flat.to !== undefined;

  const first = result.total === 0 ? 0 : (result.page - 1) * result.pageSize + 1;
  const last = Math.min(result.page * result.pageSize, result.total);

  function pageHref(target: number): string {
    const params = new URLSearchParams(flat);
    params.set("page", String(target));
    return `/admin/audit?${params.toString()}`;
  }

  return (
    <div>
      <Link
        href="/admin"
        className="text-sm text-[var(--accent)] underline underline-offset-2"
      >
        ← All employees
      </Link>

      <h1 className="mt-4 text-xl font-semibold">Audit log</h1>
      <p className="mt-2 max-w-2xl text-sm text-[var(--muted)]">
        Every grant, revoke, status change and profile change, plus what the
        Change Orders module did to the mailbox. Append-only and enforced by the
        database — nothing here can be edited or removed, including by an
        administrator.
      </p>

      {filterError !== null && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {filterError} Showing everything instead.
        </p>
      )}

      <form method="GET" className="mt-6 flex flex-wrap items-end gap-3">
        <Labelled label="About (target)">
          <PersonSelect name="targetEmployeeId" people={options.targets} value={flat.targetEmployeeId} />
        </Labelled>

        <Labelled label="Done by (actor)">
          <PersonSelect name="actorEmployeeId" people={options.actors} value={flat.actorEmployeeId} />
        </Labelled>

        <Labelled label="Action">
          <select
            name="action"
            defaultValue={flat.action ?? ""}
            className="rounded border border-[var(--border)] bg-white px-3 py-1.5 text-sm"
          >
            <option value="">Any</option>
            {knownAuditActions().map(({ action, label }) => (
              <option key={action} value={action}>
                {label}
              </option>
            ))}
          </select>
        </Labelled>

        <Labelled label="From">
          <input
            type="date"
            name="from"
            defaultValue={flat.from ?? ""}
            className="rounded border border-[var(--border)] px-3 py-1.5 text-sm"
          />
        </Labelled>

        <Labelled label="To">
          <input
            type="date"
            name="to"
            defaultValue={flat.to ?? ""}
            className="rounded border border-[var(--border)] px-3 py-1.5 text-sm"
          />
        </Labelled>

        <button
          type="submit"
          className="rounded bg-[var(--accent)] px-4 py-1.5 text-sm font-medium text-white"
        >
          Apply
        </button>
        {filtered && (
          <Link
            href="/admin/audit"
            className="px-2 py-1.5 text-sm text-[var(--muted)] underline underline-offset-2"
          >
            Clear filters
          </Link>
        )}
      </form>

      <p className="mt-4 text-sm text-[var(--muted)]">
        {result.total === 0
          ? "No events"
          : `${result.total} event${result.total === 1 ? "" : "s"}`}
        {filtered && " matching these filters"}
      </p>

      <div className="mt-2 rounded border border-[var(--border)]">
        <AuditList
          events={result.events}
          moduleNames={moduleNames}
          emptyMessage={
            /*
              Two different empty states. "No events at all" means the platform
              has never recorded anything, which for a system in use is a
              symptom; "nothing matched" means the filters are too narrow. They
              read differently because they call for different actions.
            */
            filtered
              ? "No events match these filters. Widen the date range, or clear them."
              : "Nothing has been recorded yet. Any grant, status change or mailbox action will appear here."
          }
        />
      </div>

      {result.totalPages > 1 && (
        <div className="mt-3 flex items-center justify-between text-sm text-[var(--muted)]">
          <span>
            {first}–{last} of {result.total}
          </span>
          <span className="flex items-center gap-3">
            {result.page > 1 && (
              <Link href={pageHref(result.page - 1)} className="underline underline-offset-2">
                Previous
              </Link>
            )}
            <span>
              Page {result.page} of {result.totalPages}
            </span>
            {result.page < result.totalPages && (
              <Link href={pageHref(result.page + 1)} className="underline underline-offset-2">
                Next
              </Link>
            )}
          </span>
        </div>
      )}
    </div>
  );
}

function PersonSelect({
  name,
  people,
  value,
}: {
  name: string;
  people: { id: string; firstName: string | null; lastName: string | null; email: string }[];
  value: string | undefined;
}) {
  return (
    <select
      name={name}
      defaultValue={value ?? ""}
      className="w-52 rounded border border-[var(--border)] bg-white px-3 py-1.5 text-sm"
    >
      <option value="">Anyone</option>
      {people.map((p) => {
        const full = [p.firstName, p.lastName].filter((x) => x).join(" ").trim();
        return (
          <option key={p.id} value={p.id}>
            {full.length > 0 ? full : p.email}
          </option>
        );
      })}
    </select>
  );
}

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-[var(--muted)]">
        {label}
      </span>
      {children}
    </label>
  );
}
