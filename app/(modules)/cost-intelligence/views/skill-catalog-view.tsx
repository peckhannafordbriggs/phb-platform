import { Fragment } from "react";
import Link from "next/link";
import { PLACEHOLDER_SETTINGS_WORKFLOWS, PLACEHOLDER_SKILLS } from "@/lib/modules/cost-intelligence/placeholder-settings";
import type { Skill } from "@/lib/modules/cost-intelligence/types";
import { Card } from "../ui/Card";
import { Node } from "./parts";

const usedBy = (id: string) => PLACEHOLDER_SETTINGS_WORKFLOWS.filter((w) => w.steps.some((s) => s.skillId === id)).length;

/** 1d: every skill on the left, the selected one on the right. */
export function SkillCatalogView({ selectedId }: { selectedId?: string }) {
  const skill = PLACEHOLDER_SKILLS.find((s) => s.id === selectedId) ?? PLACEHOLDER_SKILLS[0]!;
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[21rem_minmax(0,1fr)] lg:min-h-[22rem] lg:flex-[1_1_0px] lg:grid-rows-[minmax(0,1fr)]">
      <Card padding="p-0" className="flex min-h-0 flex-col">
        <div className="shrink-0 border-b border-[var(--divider-soft)] px-5 py-4">
          <span className="eyebrow text-[var(--muted)]">Skills</span>
        </div>
        <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
          {PLACEHOLDER_SKILLS.map((s) => (
            <li key={s.id}>
              <SkillRow skill={s} selected={s.id === skill.id} />
            </li>
          ))}
        </ul>
      </Card>
      <SkillDetail skill={skill} />
    </div>
  );
}

function SkillRow({ skill, selected }: { skill: Skill; selected: boolean }) {
  return (
    <Link
      href={`/cost-intelligence/settings/skills/${skill.id}`}
      aria-current={selected ? "page" : undefined}
      className={
        "block rounded-[var(--radius-row)] border-l-2 px-4 py-3 transition-colors " +
        (selected ? "border-[var(--module-accent)] bg-white shadow-sm" : "border-transparent hover:bg-[var(--neutral-50)]")
      }
    >
      <p className="truncate text-[0.875rem] font-semibold">{skill.name}</p>
      <p className="mt-1.5 font-mono text-[0.75rem]">{skill.live ?? "—"}</p>
    </Link>
  );
}

function SkillDetail({ skill }: { skill: Skill }) {
  const n = usedBy(skill.id);

  return (
    <Card padding="p-0" className="min-h-0 overflow-y-auto">
      <div className="px-6 pt-5">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="min-w-0">
            <h2 className="text-xl font-semibold">{skill.name}</h2>
            <p className="mt-1 font-mono text-[0.75rem] text-[var(--muted)]">
              Used by {n} workflow{n === 1 ? "" : "s"}
            </p>
          </div>
          <p className="font-mono text-[0.75rem]">{skill.live ?? "—"}</p>
        </div>
        <VersionTrack skill={skill} />
      </div>
    </Card>
  );
}

function VersionTrack({ skill }: { skill: Skill }) {
  return (
    <ol className="flex items-start overflow-x-auto py-6">
      {skill.versions.map((v, i) => {
        const live = v === skill.live;
        return (
          <Fragment key={v}>
            {i > 0 && <li aria-hidden="true" className="mt-[8px] h-px min-w-8 flex-1 bg-[var(--neutral-200)]" />}
            <li className="flex w-24 shrink-0 flex-col items-center gap-2">
              <Node size={16} filled={live} color={live ? "var(--phb-teal-ink)" : "var(--neutral-400)"} />
              <span className={"font-mono text-[0.75rem] " + (live ? "font-semibold" : "text-[var(--muted)]")}>{v}</span>
              {live && <span className="eyebrow -mt-1 text-[var(--phb-teal-ink)]">Live</span>}
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}
