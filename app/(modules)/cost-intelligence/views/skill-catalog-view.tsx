import Link from "next/link";
import type { CipSkill, CipSkillSync } from "@/lib/generated/prisma/client";
import { Card } from "../ui/Card";
import { Pill } from "../ui/Pill";
import { SkillSyncButton } from "./skill-sync-button";

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
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--divider-soft)] px-5 py-3">
          <span className="eyebrow text-[var(--muted)]">Skills · {skills.length}</span>
          <SkillSyncButton />
        </div>
        <SyncStatus sync={lastSync} />
        <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
          {skills.map((s) => (
            <li key={s.folderName}>
              <SkillRow skill={s} selected={s.folderName === selected?.folderName} />
            </li>
          ))}
        </ul>
      </Card>
      {selected ? <SkillDetail skill={selected} /> : <EmptyCatalog />}
    </div>
  );
}

function SyncStatus({ sync }: { sync: CipSkillSync | null }) {
  if (sync === null) {
    return <p className="px-5 pt-3 text-[0.75rem] text-[var(--muted)]">Never synced.</p>;
  }
  if (sync.status === "running") {
    return <p className="px-5 pt-3 text-[0.75rem] text-[var(--muted)]">Sync in progress…</p>;
  }

  const when = MOMENT.format(sync.finishedAt ?? sync.startedAt);

  if (sync.status === "failed") {
    const reason = firstReason(sync.errors);
    return (
      <div className="flex flex-col gap-1 px-5 pt-3 text-[0.75rem]">
        <span>
          <Pill tone="warn">Sync failed</Pill> <span className="text-[var(--muted)]">{when}</span>
        </span>
        {reason && <span className="text-[var(--muted)]">{reason}</span>}
      </div>
    );
  }

  const skipped = Array.isArray(sync.errors) ? sync.errors.length : 0;
  return (
    <p className="px-5 pt-3 text-[0.75rem] text-[var(--muted)]">
      Last synced {when}
      {sync.status === "partial" && (
        <>
          {" "}
          <Pill tone="warn">{skipped} could not be read</Pill>
        </>
      )}
    </p>
  );
}

function firstReason(errors: unknown): string | null {
  if (!Array.isArray(errors)) return null;
  const first: unknown = errors[0];
  return first !== null && typeof first === "object" && "reason" in first && typeof first.reason === "string"
    ? first.reason
    : null;
}

function SkillRow({ skill, selected }: { skill: CipSkill; selected: boolean }) {
  return (
    <Link
      href={`/cost-intelligence/settings/skills/${encodeURIComponent(skill.folderName)}`}
      aria-current={selected ? "page" : undefined}
      className={
        "block rounded-[var(--radius-row)] border-l-2 px-4 py-3 transition-colors " +
        (selected ? "border-[var(--module-accent)] bg-white shadow-sm" : "border-transparent hover:bg-[var(--neutral-50)]")
      }
    >
      <p className="truncate text-[0.875rem] font-semibold">{skill.name}</p>
      <p className="mt-1.5 font-mono text-[0.75rem] text-[var(--muted)]">
        v{skill.version} · {DAY.format(skill.lastModified)}
      </p>
    </Link>
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
