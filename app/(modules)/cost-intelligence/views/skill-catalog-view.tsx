import type { CipSkill, CipSkillSync } from "@/lib/generated/prisma/client";
import { Card } from "../ui/Card";
import { Pill } from "../ui/Pill";
import { SideList, SyncButton, SyncStatus } from "./side-list";

/** CHANGELOG dates are stored as midnight UTC; formatting in UTC keeps them on the right day. */
const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const MOMENT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "America/New_York",
});

/** 1d: every skill on the left, the selected one on the right. Data comes from cip_skills. */
export function SkillCatalogView({
  skills,
  selected,
  lastSync,
}: {
  skills: CipSkill[];
  selected: CipSkill | null;
  lastSync: CipSkillSync | null;
}) {
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[21rem_minmax(0,1fr)] lg:min-h-[22rem] lg:flex-[1_1_0px] lg:grid-rows-[minmax(0,1fr)]">
      <Card padding="p-0" className="flex min-h-0 flex-col">
        <div className="shrink-0 border-b border-[var(--divider-soft)] px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <span className="eyebrow whitespace-nowrap text-[var(--muted)]">Skills · {skills.length}</span>
            <SyncButton url="/api/modules/cost-intelligence/sync/skills" />
          </div>
          <SyncStatus
            sync={
              lastSync && {
                ...lastSync,
                added: lastSync.skillsAdded,
                updated: lastSync.skillsUpdated,
                removed: lastSync.skillsDeleted,
              }
            }
          />
        </div>
        <SideList
          items={skills.map((s) => ({
            id: s.folderName,
            href: `/cost-intelligence/settings/skills/${encodeURIComponent(s.folderName)}`,
            label: s.name,
            meta: `v${s.version}`,
            mono: true,
          }))}
          selected={selected?.folderName ?? null}
          empty="No skills yet. Press Sync to read the skills folder."
        />
      </Card>
      {selected ? <SkillDetail skill={selected} /> : <EmptyCatalog />}
    </div>
  );
}

function SkillDetail({ skill }: { skill: CipSkill }) {
  return (
    <Card padding="p-0" className="min-h-0 overflow-y-auto">
      <div className="flex flex-col gap-5 px-6 py-5">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="min-w-0">
            <h2 className="text-xl font-semibold">{skill.name}</h2>
            <p className="mt-1 font-mono text-[0.75rem] text-[var(--muted)]">{skill.folderName}</p>
          </div>
          <Pill tone="muted">v{skill.version}</Pill>
        </div>

        <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-4 gap-y-2 text-[0.8125rem]">
          <dt className="text-[var(--muted)]">Version</dt>
          <dd>v{skill.version}</dd>
          <dt className="text-[var(--muted)]">Last updated</dt>
          <dd>{DAY.format(skill.lastModified)}</dd>
          <dt className="text-[var(--muted)]">Last synced</dt>
          <dd>{MOMENT.format(skill.lastSynced)}</dd>
        </dl>

        <div>
          <span className="eyebrow text-[var(--muted)]">Description</span>
          <p className="mt-2 text-[0.875rem] leading-relaxed">{skill.description}</p>
        </div>
      </div>
    </Card>
  );
}

function EmptyCatalog() {
  return (
    <Card className="flex min-h-0 items-center justify-center">
      <p className="text-[0.875rem] text-[var(--muted)]">No skills yet. Press Sync to read the skills folder.</p>
    </Card>
  );
}
