"use client";

import { useState } from "react";
import { Check, Plus } from "lucide-react";
import { CIP_PERMISSIONS, CIP_ROLES, PLACEHOLDER_PEOPLE } from "@/lib/modules/cost-intelligence/placeholder-settings";
import type { RoleId } from "@/lib/modules/cost-intelligence/types";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Dropdown } from "../ui/Dropdown";

const ROLE_OPTIONS = CIP_ROLES.map((r) => ({ value: r.id, label: r.name }));
const PCE_ONLY = ROLE_OPTIONS.filter((o) => o.value === "pce");

const initials = (name: string) =>
  name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

/** Who has which role, beside what each role can do. */
export function AccessView() {
  const [people, setPeople] = useState(PLACEHOLDER_PEOPLE);
  const [permissions, setPermissions] = useState(CIP_PERMISSIONS);
  const count = (role: RoleId) => people.filter((p) => p.role === role).length;

  function setRole(id: string, role: RoleId) {
    setPeople((all) => all.map((p) => (p.id === id ? { ...p, role } : p)));
  }

  function toggle(label: string, role: RoleId) {
    setPermissions((all) =>
      all.map((p) =>
        p.label !== label ? p : { ...p, roles: p.roles.includes(role) ? p.roles.filter((r) => r !== role) : [...p.roles, role] },
      ),
    );
  }

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-2 xl:min-h-[22rem] xl:flex-[1_1_0px] xl:grid-rows-[minmax(0,1fr)]">
      <Card padding="p-0" className="flex min-h-0 flex-col">
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--divider-soft)] px-5 py-3">
          <span className="eyebrow text-[var(--muted)]">People · {people.length}</span>
          <Button>
            <Plus size={14} aria-hidden="true" />
            Add person
          </Button>
        </div>
        <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_11rem_6rem] gap-4 px-5 pb-2 pt-4">
          <span className="eyebrow text-[var(--muted)]">Name</span>
          <span className="eyebrow text-[var(--muted)]">Role</span>
          <span className="eyebrow text-right text-[var(--muted)]">Last active</span>
        </div>
        <ul className="min-h-0 flex-1 divide-y divide-[var(--divider-soft)] overflow-y-auto">
          {people.map((p) => {
            const lastPce = p.role === "pce" && count("pce") === 1;
            return (
              <li key={p.id} className="grid grid-cols-[minmax(0,1fr)_11rem_6rem] items-center gap-4 px-5 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--neutral-100)] text-[0.6875rem] font-semibold text-[var(--muted)]">
                    {initials(p.name)}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-[0.875rem] font-medium">{p.name}</p>
                    <p className="truncate font-mono text-[0.75rem] text-[var(--muted)]">{p.email}</p>
                  </div>
                </div>
                <Dropdown
                  label={`Role for ${p.name}${lastPce ? ". Give someone else PCE first" : ""}`}
                  options={lastPce ? PCE_ONLY : ROLE_OPTIONS}
                  value={p.role}
                  onChange={(v) => setRole(p.id, v as RoleId)}
                />
                <span className="text-right text-[0.8125rem] text-[var(--muted)]">{p.lastActive}</span>
              </li>
            );
          })}
        </ul>
      </Card>

      <Card padding="p-0" className="flex min-h-0 flex-col">
        <div className="shrink-0 border-b border-[var(--divider-soft)] px-5 py-4">
          <span className="eyebrow text-[var(--muted)]">What each role can do</span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-5 py-3">
          <table className="w-full text-[0.8125rem]">
            <thead>
              <tr>
                <th />
                {CIP_ROLES.map((r) => (
                  <th key={r.id} className="w-20 px-1 pb-3 text-center align-bottom font-semibold">
                    {r.name}
                    <span className="block text-[0.6875rem] font-normal text-[var(--muted)]">
                      {count(r.id)} {count(r.id) === 1 ? "person" : "people"}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {permissions.map((perm) => (
                <tr key={perm.label} className="border-t border-[var(--divider-soft)]">
                  <td className="py-2.5 pr-4">{perm.label}</td>
                  {CIP_ROLES.map((r) => {
                    const on = perm.roles.includes(r.id);
                    const fixed = r.id === "pce";
                    return (
                      <td key={r.id} className="text-center">
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked={on}
                          aria-label={`${r.name}: ${perm.label}`}
                          disabled={fixed}
                          onClick={() => toggle(perm.label, r.id)}
                          className={
                            "inline-flex h-5 w-5 items-center justify-center rounded border align-middle text-white transition-colors " +
                            (fixed
                              ? "border-transparent bg-[var(--neutral-400)]"
                              : on
                                ? "border-transparent bg-[var(--phb-purple)]"
                                : "border-[var(--neutral-300)] bg-white hover:border-[var(--neutral-500)]")
                          }
                        >
                          {on && <Check size={12} strokeWidth={3} aria-hidden="true" />}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="shrink-0 border-t border-[var(--divider-soft)] px-5 py-4 text-[0.75rem] text-[var(--muted)]">
          PCE permissions are fixed. SharePoint folder permissions still apply on top of these roles: people only see jobs
          they can open in SharePoint.
        </p>
      </Card>
    </div>
  );
}
