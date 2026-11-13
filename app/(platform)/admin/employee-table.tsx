"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState, useTransition } from "react";
import { APP_TIME_ZONE } from "@/lib/activity/rollover";
import { moduleAccent } from "@/lib/module-accent";
import { hasSettingsSurface } from "@/lib/module-settings";
import { Button, Card, Dropdown, Empty, Pill, SearchBar, Switch, Table } from "@/components/ui";
import { BulkBar } from "./bulk-bar";

/**
 * The Employees list (restyled onto the kit 2026-11-13).
 *
 * Three things decided here rather than on the server:
 *
 *   - **The filters narrow this page live, and Apply runs the query.** Typing
 *     or picking narrows the rows already on screen as you go; Apply - the
 *     one red button - sends the drafted filters to the server and puts them
 *     in the URL, so a filtered view can be shared or paged. The count line
 *     says which of the two it is describing, because "3 of 25 on this page
 *     match" and "3 employees match" are different claims.
 *   - **Every navigation from this screen carries the draft.** A sort, a
 *     page, Apply: all of them run the filters as drafted, because a draft a
 *     person can see is the query they mean. Reset clears the draft and the
 *     URL together.
 *   - **The Access column is a count; the row's panel is the picture.** A
 *     collapsed row says "4 modules" or "No access" and nothing more, and
 *     sorts by that count. The chevron expands the row to every active
 *     module - granted ones first - with the module's diamond, its full name,
 *     a switch for the grant and one for its settings rights, edited through
 *     the same routes the employee page uses, with the same audit events and
 *     the same platform-admin check behind them. The panel is a wrapping
 *     grid, so fifteen modules are four rows of cards and never a horizontal
 *     scroll. Nowhere else on the list names a specific grant.
 */

export interface AdminEmployeeRow {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  positionOther: string | null;
  profileCompleted: boolean;
  status: "active" | "disabled";
  isPlatformAdmin: boolean;
  lastLoginAt: Date | string | null;
  position: { id: string; name: string } | null;
  department: { id: string; name: string } | null;
  grantedModuleKeys: string[];
  /** The subset of grantedModuleKeys whose grant carries is_module_admin. */
  moduleAdminKeys: string[];
}

export interface AdminModule {
  key: string;
  displayName: string;
}

export type EmployeeSort = "access" | "name" | "lastLogin" | "status";
export type SortDir = "asc" | "desc";
export type Scope = "granted" | "all" | "none";

export interface EmployeeFilters {
  q: string;
  moduleKey: string;
  status: string;
  departmentId: string;
  scope: Scope;
}

export const DEFAULT_FILTERS: EmployeeFilters = { q: "", moduleKey: "", status: "", departmentId: "", scope: "all" };
export const DEFAULT_SORT: EmployeeSort = "access";
export const DEFAULT_DIR: SortDir = "asc";

/** The `grid-template-columns` of the list: chevron, checkbox, then the seven columns. */
export const EMPLOYEE_COLUMNS =
  "1.5rem 1.25rem minmax(11.5rem,1.5fr) minmax(11.5rem,1.4fr) minmax(6rem,0.8fr) minmax(6rem,0.8fr) 4.5rem 7.25rem minmax(10rem,1.6fr)";

const STATUS_OPTIONS = [
  { value: "", label: "Any" },
  { value: "active", label: "Active" },
  { value: "disabled", label: "Disabled" },
];

/**
 * "No grants at all" is its own case, not the absence of a module filter.
 * "Who signed in and never got access" is a question an admin actually asks
 * and cannot express as any combination of the other filters.
 */
const SCOPE_OPTIONS: { value: Scope; label: string }[] = [
  { value: "all", label: "Everyone" },
  { value: "granted", label: "With a grant" },
  { value: "none", label: "No grants at all" },
];

/**
 * Whether a row on this page passes the filters as drafted - the live
 * narrowing. The same questions the server asks (lib/admin/service.ts,
 * `listEmployees`): the search over first name, last name and email, each
 * case-insensitively; a module filter that wins over the scope; the scope
 * otherwise.
 */
export function matchesFilters(row: AdminEmployeeRow, filters: EmployeeFilters): boolean {
  const q = filters.q.trim().toLowerCase();
  if (q.length > 0) {
    const hit =
      row.firstName.toLowerCase().includes(q) ||
      row.lastName.toLowerCase().includes(q) ||
      row.email.toLowerCase().includes(q);
    if (!hit) return false;
  }
  if (filters.departmentId !== "" && row.department?.id !== filters.departmentId) return false;
  if (filters.status !== "" && row.status !== filters.status) return false;
  if (filters.moduleKey !== "") return row.grantedModuleKeys.includes(filters.moduleKey);
  if (filters.scope === "granted") return row.grantedModuleKeys.length > 0;
  if (filters.scope === "none") return row.grantedModuleKeys.length === 0;
  return true;
}

export function sameFilters(a: EmployeeFilters, b: EmployeeFilters): boolean {
  return (
    a.q.trim() === b.q.trim() &&
    a.moduleKey === b.moduleKey &&
    a.status === b.status &&
    a.departmentId === b.departmentId &&
    a.scope === b.scope
  );
}

/**
 * The URL for a view: only what differs from the defaults travels, so the
 * default view is `/admin` and a shared link says exactly what was chosen.
 */
export function listHref(filters: EmployeeFilters, sort: EmployeeSort, dir: SortDir, page: number): string {
  const params = new URLSearchParams();
  const q = filters.q.trim();
  if (q.length > 0) params.set("q", q);
  if (filters.moduleKey !== "") params.set("moduleKey", filters.moduleKey);
  if (filters.status !== "") params.set("status", filters.status);
  if (filters.departmentId !== "") params.set("departmentId", filters.departmentId);
  if (filters.scope !== DEFAULT_FILTERS.scope) params.set("scope", filters.scope);
  if (sort !== DEFAULT_SORT || dir !== DEFAULT_DIR) {
    params.set("sort", sort);
    params.set("dir", dir);
  }
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query.length > 0 ? `/admin?${query}` : "/admin";
}

/**
 * The direction a column opens in: ascending for a name, a status and the
 * access count (fewest first is the question), descending for a date, since
 * "most recent first" is what somebody wants from a last-sign-in column.
 */
export function naturalDirection(column: EmployeeSort): SortDir {
  return column === "lastLogin" ? "desc" : "asc";
}

/** Clicking the active column flips it; clicking another opens it in its natural direction. */
export function nextSort(current: { sort: EmployeeSort; dir: SortDir }, column: EmployeeSort): { sort: EmployeeSort; dir: SortDir } {
  if (current.sort === column) return { sort: column, dir: current.dir === "asc" ? "desc" : "asc" };
  return { sort: column, dir: naturalDirection(column) };
}

export function EmployeesView({
  employees,
  modules,
  departments,
  applied,
  sort,
  dir,
  page,
  pageSize,
  total,
  employeesTotal,
  totalPages,
  filtered,
}: {
  employees: AdminEmployeeRow[];
  modules: AdminModule[];
  departments: { id: string; name: string }[];
  /** The filters the server answered - what the URL says. */
  applied: EmployeeFilters;
  sort: EmployeeSort;
  dir: SortDir;
  page: number;
  pageSize: number;
  total: number;
  /** Every employee, before any filter. Distinguishes the two empty states. */
  employeesTotal: number;
  totalPages: number;
  /** Whether the applied view is narrowed at all. */
  filtered: boolean;
}) {
  const router = useRouter();
  const [refreshing, startTransition] = useTransition();

  const [draft, setDraft] = useState<EmployeeFilters>(applied);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const narrowed = !sameFilters(draft, applied);
  const visible = narrowed ? employees.filter((e) => matchesFilters(e, draft)) : employees;

  function go(href: string) {
    startTransition(() => router.push(href));
  }

  function apply() {
    go(listHref(draft, sort, dir, 1));
  }

  function reset() {
    setDraft(DEFAULT_FILTERS);
    go("/admin");
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) =>
      visible.length > 0 && visible.every((e) => prev.has(e.id))
        ? new Set()
        : new Set(visible.map((e) => e.id)),
    );
  }

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /**
   * One request through the existing admin routes, then a server refresh.
   * The routes are the employee page's own - `withAdmin` on every one, the
   * audit row written inside the change's transaction - so a switch here is
   * the checkbox there, and nothing new can be reached from this screen.
   */
  async function call(employeeId: string, path: string, init: RequestInit): Promise<void> {
    setBusyId(employeeId);
    setErrors((prev) => {
      const next = { ...prev };
      delete next[employeeId];
      return next;
    });
    try {
      const response = await fetch(path, init);
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setErrors((prev) => ({
          ...prev,
          [employeeId]: payload?.error?.message ?? "The action could not be completed.",
        }));
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setErrors((prev) => ({ ...prev, [employeeId]: "Could not reach the server." }));
    } finally {
      setBusyId(null);
    }
  }

  function setGrant(employeeId: string, moduleKey: string, granted: boolean) {
    void call(
      employeeId,
      granted
        ? `/api/admin/employees/${employeeId}/grants`
        : `/api/admin/employees/${employeeId}/grants/${encodeURIComponent(moduleKey)}`,
      granted
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ moduleKey }),
          }
        : { method: "DELETE" },
    );
  }

  function setModuleAdmin(employeeId: string, moduleKey: string, isModuleAdmin: boolean) {
    void call(employeeId, `/api/admin/employees/${employeeId}/grants/${encodeURIComponent(moduleKey)}/admin`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isModuleAdmin }),
    });
  }

  const sortHref = (column: EmployeeSort) => {
    const next = nextSort({ sort, dir }, column);
    // Always back to page 1: page 4 of a differently ordered list is a slice nobody asked for.
    return listHref(draft, next.sort, next.dir, 1);
  };

  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  const countLine = narrowed
    ? `${visible.length} of ${employees.length} on this page match. Apply to search all ${employeesTotal}.`
    : total === 0
      ? "No employees"
      : `${total} ${total === 1 ? "employee" : "employees"}` +
        (filtered ? " matching the current filters" + (total !== employeesTotal ? ` · ${employeesTotal} in total` : "") : "");

  const headers: React.ReactNode[] = [
    <span key="expand" className="sr-only">
      Access panel
    </span>,
    <input
      key="all"
      type="checkbox"
      aria-label="Select all on this page"
      checked={visible.length > 0 && visible.every((e) => selected.has(e.id))}
      onChange={toggleAll}
    />,
    <SortHeader key="name" column="name" label="Name" sort={sort} dir={dir} href={sortHref("name")} />,
    "Email",
    <span key="position">
      Position <span className="font-normal normal-case italic tracking-normal">self-reported</span>
    </span>,
    "Department",
    <SortHeader key="status" column="status" label="Status" sort={sort} dir={dir} href={sortHref("status")} />,
    <SortHeader key="lastLogin" column="lastLogin" label="Last sign-in" sort={sort} dir={dir} href={sortHref("lastLogin")} />,
    <SortHeader key="access" column="access" label="Access" sort={sort} dir={dir} href={sortHref("access")} />,
  ];

  const rows = visible.map((e) => {
    const open = expanded.has(e.id);
    const name = `${e.firstName} ${e.lastName}`.trim() || e.email;
    return [
      <button
        key="expand"
        type="button"
        aria-expanded={open}
        aria-label={`${open ? "Hide" : "Show"} access for ${name}`}
        onClick={() => toggleExpanded(e.id)}
        className="rounded p-0.5 text-[var(--muted)] hover:bg-[var(--neutral-100)] hover:text-[var(--foreground)]"
      >
        {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
      </button>,
      <input
        key="select"
        type="checkbox"
        aria-label={`Select ${e.email}`}
        checked={selected.has(e.id)}
        onChange={() => toggle(e.id)}
      />,
      <span key="name" className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <Link href={`/admin/${e.id}`} className="truncate text-[var(--accent)] underline underline-offset-2">
            {name}
          </Link>
          {e.isPlatformAdmin && (
            <span className="shrink-0 rounded-full bg-[var(--phb-purple)] px-1.5 py-px text-[0.5625rem] font-medium uppercase tracking-wide text-white">
              Admin
            </span>
          )}
        </span>
        {/* Its own line, so the note never shortens the name beside it. */}
        {!e.profileCompleted && <span className="text-[0.6875rem] italic text-[var(--muted)]">profile incomplete</span>}
      </span>,
      <span key="email" title={e.email} className="font-mono text-[0.6875rem] text-[var(--muted)]">
        {e.email}
      </span>,
      e.position?.name ??
        (e.positionOther !== null ? (
          <span key="position" title="Free text - needs admin cleanup">
            {e.positionOther} <span className="text-[var(--muted)]">(other)</span>
          </span>
        ) : (
          <span key="position" className="text-[var(--muted)]">
            —
          </span>
        )),
      e.department?.name ?? (
        <span key="department" className="text-[var(--muted)]">
          —
        </span>
      ),
      // A pill, not just a colour: the two states differ in word as well as hue.
      <Pill key="status" tone={e.status === "active" ? "ok" : "bad"}>
        {e.status === "active" ? "Active" : "Disabled"}
      </Pill>,
      <span key="login" className="font-mono text-[0.6875rem] tabular-nums text-[var(--muted)]">
        {formatDate(e.lastLoginAt)}
      </span>,
      <AccessCell key="access" employee={e} modules={modules} />,
    ];
  });

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            apply();
          }}
          className="flex flex-wrap items-end gap-3"
        >
          <Field label="Search">
            <SearchBar
              label="Search employees"
              placeholder="Name or email"
              value={draft.q}
              onChange={(q) => setDraft((d) => ({ ...d, q }))}
              className="w-56"
            />
          </Field>
          <Field label="Module">
            <Dropdown
              label="Module"
              options={[{ value: "", label: "Any" }, ...modules.map((m) => ({ value: m.key, label: m.displayName }))]}
              value={draft.moduleKey}
              onChange={(moduleKey) => setDraft((d) => ({ ...d, moduleKey }))}
              className="w-44"
            />
          </Field>
          <Field label="Status">
            <Dropdown
              label="Status"
              options={STATUS_OPTIONS}
              value={draft.status}
              onChange={(status) => setDraft((d) => ({ ...d, status }))}
              className="w-28"
            />
          </Field>
          <Field label="Department">
            <Dropdown
              label="Department"
              options={[{ value: "", label: "Any" }, ...departments.map((d) => ({ value: d.id, label: d.name }))]}
              value={draft.departmentId}
              onChange={(departmentId) => setDraft((d) => ({ ...d, departmentId }))}
              className="w-40"
            />
          </Field>
          <Field label="Show">
            <Dropdown
              label="Show"
              options={SCOPE_OPTIONS}
              value={draft.scope}
              onChange={(scope) => setDraft((d) => ({ ...d, scope: scope as Scope }))}
              className="w-40"
            />
          </Field>
          <div className="flex items-center gap-2">
            <Button type="submit" variant="primary" disabled={refreshing}>
              Apply
            </Button>
            <Button onClick={reset} disabled={refreshing}>
              Reset
            </Button>
          </div>
        </form>
        <p className="mt-3 text-[0.8125rem] text-[var(--muted)]" data-testid="admin-employees-count">
          {countLine}
        </p>
      </Card>

      <BulkBar
        selectedIds={[...selected]}
        modules={modules}
        onClear={() => setSelected(new Set())}
        onDone={() => {
          setSelected(new Set());
          startTransition(() => router.refresh());
        }}
      />

      <Card>
        {employees.length === 0 ? (
          <Empty>
            {/*
              PHASE-10: "no results from a filter reads differently from no
              employees at all". They call for different actions - one is
              "widen the filter", the other is "nobody has signed in yet" -
              and a single message would send an admin looking for a filter
              to clear on a platform that has no rows to show.
            */}
            {employeesTotal === 0 ? (
              <>
                <p className="font-medium text-[var(--foreground)]">Nobody has signed in yet</p>
                <p>Employees appear here the first time they sign in. There is no way to create one.</p>
              </>
            ) : (
              <>
                <p className="font-medium text-[var(--foreground)]">No employees match these filters</p>
                <p>
                  {employeesTotal} {employeesTotal === 1 ? "employee" : "employees"} exist in total.{" "}
                  <Link href="/admin" className="underline underline-offset-2">
                    Show everyone
                  </Link>
                  .
                </p>
              </>
            )}
          </Empty>
        ) : visible.length === 0 ? (
          <Empty>
            <p className="font-medium text-[var(--foreground)]">No one on this page matches</p>
            <p>Apply to search all {employeesTotal} employees.</p>
          </Empty>
        ) : (
          <div className="overflow-x-auto">
            <Table
              headers={headers}
              rows={rows}
              columns={EMPLOYEE_COLUMNS}
              detail={(index) => {
                const employee = visible[index];
                if (employee === undefined || !expanded.has(employee.id)) return null;
                return (
                  <AccessPanel
                    employee={employee}
                    modules={modules}
                    busy={busyId === employee.id || refreshing}
                    error={errors[employee.id] ?? null}
                    onGrant={(moduleKey, granted) => setGrant(employee.id, moduleKey, granted)}
                    onModuleAdmin={(moduleKey, isModuleAdmin) => setModuleAdmin(employee.id, moduleKey, isModuleAdmin)}
                  />
                );
              }}
            />
          </div>
        )}

        <div className="mt-4 flex items-center justify-between text-[0.8125rem] text-[var(--muted)]">
          <span>
            {first}–{last} of {total}
          </span>
          <span className="flex items-center gap-2">
            <Button size="sm" href={listHref(draft, sort, dir, page - 1)} disabled={page <= 1}>
              Previous
            </Button>
            <span>
              Page {page} of {totalPages}
            </span>
            <Button size="sm" href={listHref(draft, sort, dir, page + 1)} disabled={page >= totalPages}>
              Next
            </Button>
          </span>
        </div>
      </Card>
    </div>
  );
}

/** A filter's label over its control - the kit's field label, as a block rather than a <label>, since each control names itself. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[0.75rem] text-[var(--muted)]">{label}</span>
      {children}
    </div>
  );
}

/**
 * A sortable column heading: a link that carries the next sort in the URL,
 * so a sorted view is bookmarkable and survives Apply. The state is in the
 * accessible name as well as the caret - a caret is invisible to a screen
 * reader, and this table is how access is administered.
 */
function SortHeader({
  column,
  label,
  sort,
  dir,
  href,
}: {
  column: EmployeeSort;
  label: string;
  sort: EmployeeSort;
  dir: SortDir;
  href: string;
}) {
  const active = sort === column;
  const state = active ? (dir === "asc" ? "sorted ascending" : "sorted descending") : "not sorted";
  return (
    <Link
      href={href}
      aria-label={`${label}, ${state}. Sort by ${label.toLowerCase()}`}
      data-sort={column}
      data-sort-state={active ? dir : "none"}
      className="inline-flex items-center gap-1 hover:underline"
    >
      {label}
      <span aria-hidden="true" className={active ? "" : "text-[var(--border)]"}>
        {active && dir === "desc" ? "▾" : "▴"}
      </span>
    </Link>
  );
}

/**
 * The Access column: how many of the active modules the person holds, in
 * words - "4 modules", "1 module" - or "No access" in grey. A count and
 * nothing else (2026-11-13, second pass): which modules is the expanded
 * panel's job, and a collapsed row stays one line whatever the person
 * holds. The column sorts by this count on the server (`sort=access`).
 */
export function AccessCell({ employee, modules }: { employee: AdminEmployeeRow; modules: AdminModule[] }) {
  const count = modules.filter((m) => employee.grantedModuleKeys.includes(m.key)).length;

  if (count === 0) return <span className="text-[var(--muted)]">No access</span>;

  return (
    <span className="tabular-nums" data-testid="admin-access-cell">
      {count} {count === 1 ? "module" : "modules"}
    </span>
  );
}

/**
 * A row's expanded panel - the one place on the list that names a specific
 * grant: every active module, granted ones first and the rest after in the
 * registry's order, each with its diamond in its colour, its full name, a
 * switch for the grant and - once granted, for a module that has a settings
 * screen - a switch for the module-admin flag, with the employee page's
 * wording.
 *
 * The settings switch is only offered once access is granted. The server
 * refuses it outright without a grant, because "administrator of a module you
 * cannot open" is not a state worth being able to reach. And only for a module
 * that has settings (lib/module-settings.ts) - except a flag that is already
 * set, which stays visible so it can be cleared.
 *
 * A wrapping grid of cards: fifteen modules are three or four rows at the
 * widths this screen runs at, and the table never scrolls sideways for them.
 */
export function AccessPanel({
  employee,
  modules,
  busy,
  error,
  onGrant,
  onModuleAdmin,
}: {
  employee: AdminEmployeeRow;
  modules: AdminModule[];
  busy: boolean;
  error: string | null;
  onGrant: (moduleKey: string, granted: boolean) => void;
  onModuleAdmin: (moduleKey: string, isModuleAdmin: boolean) => void;
}) {
  const name = `${employee.firstName} ${employee.lastName}`.trim() || employee.email;

  // Granted first, then the rest; within each, the registry's own order. The
  // index is the module's place in the registry, which is what the accent
  // lookup's fallback keys on, so a card's colour does not move with the sort.
  const ordered = modules
    .map((m, index) => ({ ...m, index, granted: employee.grantedModuleKeys.includes(m.key) }))
    .sort((a, b) => Number(b.granted) - Number(a.granted) || a.index - b.index);

  return (
    <div data-testid="admin-access-panel">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="eyebrow text-[var(--muted)]">Access · {name}</span>
        <Button size="sm" href={`/admin/${employee.id}`}>
          Open full record
        </Button>
      </div>

      {modules.length === 0 ? (
        <p className="mt-3 text-[var(--muted)]">No active modules exist.</p>
      ) : (
        <ul className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-3">
          {ordered.map((m) => {
            const granted = m.granted;
            const isAdmin = employee.moduleAdminKeys.includes(m.key);
            const settings = hasSettingsSurface(m.key);
            return (
              <li
                key={m.key}
                className="rounded-[var(--radius-control)] border border-[var(--border)] bg-white px-3 py-2.5"
                data-testid="admin-access-module"
                data-granted={granted ? "true" : "false"}
              >
                <div className="flex items-center gap-2">
                  <span
                    className="diamond diamond--filled"
                    style={{ color: moduleAccent(m.key, m.index).fill }}
                    aria-hidden="true"
                  />
                  <span className="font-medium">{m.displayName}</span>
                </div>
                <div className="mt-2 flex flex-col gap-2">
                  <Switch label="Access" checked={granted} disabled={busy} onChange={(next) => onGrant(m.key, next)} />
                  {granted && (settings || isAdmin) && (
                    <Switch
                      label="Can change settings"
                      description={
                        settings ? undefined : (
                          <span className="text-[var(--warning)]">This module has no settings screen. Clear this.</span>
                        )
                      }
                      checked={isAdmin}
                      disabled={busy}
                      onChange={(next) => onModuleAdmin(m.key, next)}
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {error !== null && (
        <p role="alert" className="mt-3 text-[0.8125rem] text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

function formatDate(value: Date | string | null): string {
  if (value === null) return "Never";
  const date = typeof value === "string" ? new Date(value) : value;
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: APP_TIME_ZONE,
  });
}
