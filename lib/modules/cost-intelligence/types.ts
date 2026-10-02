/** One execution of a workflow against one project. */
export type Run = {
  id: string;
  project: string;
  workflow: string;
  status: string;
  started: string;
};

/** One line of a run's ledger: what happened, and when. */
export type LedgerEntry = { time: string; title: string; detail?: string };

/** One of the seven timeline steps, and how far the run has got through it. */
export type RunStep = { name: string; state: "done" | "current" | "pending"; time?: string };

/** A skill version a run is pinned to for its whole life. */
export type PinnedSkill = { name: string; version: string };

/** Everything the Run page shows beyond the run itself. */
export type RunActivity = {
  ledger: LedgerEntry[];
  steps: RunStep[];
  pinned: PinnedSkill[];
  tokens: number;
  /** Estimated cost in US dollars. */
  cost: number;
};

/** A choice in a dropdown: the stored value and what a person reads. */
export type Option = { value: string; label: string };


export type Skill = {
  id: string;
  name: string;
  live: string | null;
  versions: string[];
};

export type WorkflowStatus = "Active" | "Paused" | "Draft";

/** One skill in a workflow. `live` follows the published tag; `pinned` stays on `version`. */
export type WorkflowStep = { skillId: string; name: string; version: string; mode: "live" | "pinned" };

export type Workflow = {
  id: string;
  name: string;
  description: string;
  status: WorkflowStatus;
  steps: WorkflowStep[];
  runs30d: number;
};

export type RoleId = "pce" | "cost-engineer" | "estimator" | "viewer";

export type Role = { id: RoleId; name: string };

/** One row of the role matrix. PCE always has every permission. */
export type Permission = { label: string; roles: RoleId[] };

export type Person = { id: string; name: string; email: string; role: RoleId; lastActive: string };

export type UsageRange = "7d" | "30d" | "quarter";

/** Spend in US dollars. */
export type SkillUsage = { skill: string; runs: number; tokens: number; spend: number };

export type Usage = { days: { date: string; spend: number }[]; bySkill: SkillUsage[] };

/** `alertAt` is the share of `limit` that sends an alert. */
export type Budget = { month: string; limit: number; spent: number; alertAt: number };
