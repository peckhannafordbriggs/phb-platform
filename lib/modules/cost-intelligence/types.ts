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
