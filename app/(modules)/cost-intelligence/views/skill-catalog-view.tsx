"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { Check } from "lucide-react";
import { PLACEHOLDER_SETTINGS_WORKFLOWS, PLACEHOLDER_SKILLS } from "@/lib/modules/cost-intelligence/placeholder-settings";
import type { Skill } from "@/lib/modules/cost-intelligence/types";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Pill, type PillTone } from "../ui/Pill";
import { Node } from "./parts";

const STATUS_TONE: Record<string, PillTone> = { Published: "ok", Draft: "draft", Retired: "muted" };

const PUBLISH_STEPS = [
  "Tag the release in Git",
  "Build the .skill package",
  "Verify package MD5",
  "Upload to Anthropic Skills API",
  "Point the registry at the new tag",
];


const usedBy = (id: string) => PLACEHOLDER_SETTINGS_WORKFLOWS.filter((w) => w.steps.some((s) => s.skillId === id)).length;

function nextVersion(live: string | null): string {
  if (!live) return "v0.1.0";
  const [major, minor] = live.slice(1).split(".").map(Number);
  return `v${major}.${(minor ?? 0) + 1}.0`;
}

export function SkillCatalogView({ selectedId }: { selectedId?: string }) {
  const skill = PLACEHOLDER_SKILLS.find((s) => s.id === selectedId) ?? PLACEHOLDER_SKILLS[0]!;
  return (
    <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[21rem_minmax(0,1fr)]">
      <Card padding="p-0">
        <div className="flex items-center justify-between border-b border-[var(--divider-soft)] px-5 py-4">
          <span className="eyebrow text-[var(--muted)]">Skills</span>
        </div>
        <ul className="flex flex-col gap-1 p-2">
          {PLACEHOLDER_SKILLS.map((s) => (
            <li key={s.id}>
              <SkillRow skill={s} selected={s.id === skill.id} />
            </li>
          ))}
        </ul>
      </Card>
      <SkillDetail key={skill.id} skill={skill} />
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
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[0.875rem] font-semibold">{skill.name}</span>
        
      </div>
      <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-[0.75rem] text-[var(--muted)]">
        <span className="font-mono text-[var(--foreground)]">{skill.live ?? "—"}</span>
      </p>
    </Link>
  );
}

function SkillDetail({ skill }: { skill: Skill }) {
  const n = usedBy(skill.id);

  return (
    <Card padding="p-0" className="overflow-hidden">
      <div className="px-6 pt-5">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <h2 className="text-xl font-semibold">{skill.name}</h2>
            </div>
            <p className="mt-1 font-mono text-[0.75rem] text-[var(--muted)]">
              Used by {n} workflow{n === 1 ? "" : "s"}
            </p>
          </div>
          <dl className="grid grid-cols-[auto_auto] gap-x-6 gap-y-1 text-[0.75rem]">
            <dd className="font-mono">{skill.live ?? "—"}</dd>
          </dl>
        </div>
        <VersionTrack skill={skill} />
      </div>
    </Card>
  );
}

function VersionTrack({ skill }: { skill: Skill }) {
  const nodes = [
    ...skill.versions.map((v) => ({ label: v, live: v === skill.live, main: false })),
  ];

  return (
    <ol className="flex items-start overflow-x-auto py-6">
      {nodes.map((n, i) => (
        <Fragment key={n.label}>
          {i > 0 && <li aria-hidden="true" className="mt-[8px] h-px min-w-8 flex-1 bg-[var(--neutral-200)]" />}
          <li className="flex w-24 shrink-0 flex-col items-center gap-2">
            <Node
              size={16}
              filled={n.live || n.main}
              color={n.live ? "var(--phb-teal-ink)" : n.main ? "var(--phb-orange)" : "var(--neutral-400)"}
            />
            <span className={"font-mono text-[0.75rem] " + (n.live || n.main ? "font-semibold" : "text-[var(--muted)]")}>
              {n.label}
            </span>
            {n.live && <span className="eyebrow -mt-1 text-[var(--phb-teal-ink)]">Live</span>}
          </li>
        </Fragment>
      ))}
    </ol>
  );
}

function Changes({ skill }: { skill: Skill }) {
  return (
    <div className="min-w-0 px-6 py-5">
      <div className="flex items-center justify-between gap-4">
        <h3 className="text-[0.875rem] font-semibold">
          Changes on main since {skill.live ? `${skill.live} (live)` : "the first commit"}
        </h3>
        <Button>Edit SKILL.md</Button>
      </div>
    </div>
  );
}

function Publish({ skill }: { skill: Skill }) {
  const [passed, setPassed] = useState(false);
  const next = nextVersion(skill.live);

  return (
    <div className="flex flex-col gap-4 border-t border-[var(--divider-soft)] bg-[var(--neutral-50)] px-5 py-5 xl:border-l xl:border-t-0">
      <section>
        <p className="eyebrow mb-3 text-[var(--muted)]">1 · Test against a fixture</p>
        <input
          value=""
          onChange={(e) => {
            setPassed(false);
          }}
          aria-label="Fixture"
          className="h-9 w-full rounded-[var(--radius-control)] border border-[var(--border)] bg-white px-3 font-mono text-[0.75rem] outline-none focus:border-[var(--module-accent)]"
        />
        {/* TODO(backend): run the checks for real. */}
        <Button fullWidth className="mt-3" onClick={() => setPassed(true)}>
          Run acceptance checks
        </Button>
      </section>

      <section className={passed ? "" : "opacity-60"}>
        <p className="eyebrow mb-1 text-[var(--muted)]">2 · Publish {next}</p>
        <Checklist items={PUBLISH_STEPS} done={false} />
        <Button fullWidth variant={passed ? "primary" : "secondary"} className="mt-3" disabled={!passed}>
          {passed ? `Publish ${next}` : "Run the checks to enable"}
        </Button>
      </section>

      <p className="text-[0.75rem] text-[var(--muted)]">
        Running jobs stay on the version they started with. New runs pick up the published tag.
      </p>
    </div>
  );
}

function Checklist({ items, done }: { items: string[]; done: boolean }) {
  return (
    <ul className="mt-2 flex flex-col">
      {items.map((c) => (
        <li key={c} className="flex items-start gap-2.5 py-1.5 text-[0.8125rem]">
          <span
            className={
              "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border " +
              (done ? "border-transparent bg-[var(--phb-teal-ink)] text-white" : "border-[var(--neutral-300)] bg-white")
            }
          >
            {done && <Check size={10} strokeWidth={3} aria-hidden="true" />}
          </span>
          {c}
        </li>
      ))}
    </ul>
  );
}
