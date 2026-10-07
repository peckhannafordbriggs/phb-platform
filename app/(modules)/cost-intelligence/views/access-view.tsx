import { Check, ExternalLink } from "lucide-react";
import { CIP_PERMISSIONS, CIP_ROLES, type CipMember } from "@/lib/modules/cost-intelligence/access";
import type { RoleId } from "@/lib/modules/cost-intelligence/types";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Pill } from "../ui/Pill";

const LAST_ACTIVE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });

const initials = (name: string) =>
  name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

/**
 * Who has Cost Intelligence, beside what each role can do. Read-only: access is
 * granted in /admin by a platform admin (PCE = "Can change settings").
 */
export function AccessView({ members }: { members: CipMember[] }) {
  const count = (role: RoleId) => members.filter((m) => m.role === role).length;

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-2 xl:min-h-[22rem] xl:flex-[1_1_0px] xl:grid-rows-[minmax(0,1fr)]">
      <Card padding="p-0" className="flex min-h-0 flex-col">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--divider-soft)] px-5 py-3">
          <span className="eyebrow whitespace-nowrap text-[var(--muted)]">People · {members.length}</span>
          <Button href="/admin">
            <ExternalLink size={14} aria-hidden="true" />
            Manage in Admin
          </Button>
        </div>
        <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_6rem_6rem] gap-4 px-5 pb-2 pt-4">
          <span className="eyebrow text-[var(--muted)]">Name</span>
          <span className="eyebrow text-[var(--muted)]">Role</span>
          <span className="eyebrow text-right text-[var(--muted)]">Last active</span>
        </div>
        {members.length === 0 ? (
          <p className="px-5 py-6 text-[0.875rem] text-[var(--muted)]">
            Nobody has Cost Intelligence yet. Grant it in Admin.
          </p>
        ) : (
          <ul className="min-h-0 flex-1 divide-y divide-[var(--divider-soft)] overflow-y-auto">
            {members.map((m) => (
              <li key={m.id} className="grid grid-cols-[minmax(0,1fr)_6rem_6rem] items-center gap-4 px-5 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--neutral-100)] text-[0.6875rem] font-semibold text-[var(--muted)]">
                    {initials(m.name)}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-[0.875rem] font-medium">{m.name}</p>
                    <p className="truncate font-mono text-[0.75rem] text-[var(--muted)]">{m.email}</p>
                  </div>
                </div>
                <span>
                  <Pill tone={m.role === "pce" ? "draft" : "muted"}>{m.role === "pce" ? "PCE" : "Member"}</Pill>
                </span>
                <span className="text-right text-[0.8125rem] text-[var(--muted)]">
                  {m.lastActiveAt ? LAST_ACTIVE.format(m.lastActiveAt) : "Never"}
                </span>
              </li>
            ))}
          </ul>
        )}
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
                  <th key={r.id} className="w-24 px-1 pb-3 text-center align-bottom font-semibold">
                    {r.name}
                    <span className="block text-[0.6875rem] font-normal text-[var(--muted)]">
                      {count(r.id)} {count(r.id) === 1 ? "person" : "people"}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {CIP_PERMISSIONS.map((perm) => (
                <tr key={perm.label} className="border-t border-[var(--divider-soft)]">
                  <td className="py-2.5 pr-4">{perm.label}</td>
                  {CIP_ROLES.map((r) => {
                    const on = perm.roles.includes(r.id);
                    return (
                      <td key={r.id} className="text-center">
                        {on ? (
                          <Check size={16} strokeWidth={2.5} className="inline text-[var(--foreground)]" aria-label="Yes" />
                        ) : (
                          <span className="text-[var(--neutral-400)]" aria-label="No">
                            –
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="shrink-0 border-t border-[var(--divider-soft)] px-5 py-4 text-[0.75rem] text-[var(--muted)]">
          A Cost Intelligence grant makes someone a Member; &ldquo;Can change settings&rdquo; on that grant makes them a PCE.
          Both are set by a platform admin in Admin. SharePoint folder permissions still apply on top: people only see jobs
          they can open in SharePoint.
        </p>
      </Card>
    </div>
  );
}
