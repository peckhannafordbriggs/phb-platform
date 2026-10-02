/**
 * Placeholder data for the Settings screens until the backend exists. Replace each
 * export with its real source, then delete this file. TODO(backend).
 */
import type { Budget, Permission, Person, Role, Skill, Usage, UsageRange, Workflow } from "./types";

const NONE = { unpublished: [], diff: [], md5: null, anthropicId: null };

export const PLACEHOLDER_SKILLS: Skill[] = [
  {
    ...NONE,
    id: "phb-bid-kickoff",
    name: "Bid kickoff",
    live: "v1.4.0",
    versions: ["v1.2.0", "v1.3.0", "v1.3.1", "v1.4.0"],
    anthropicId: "skill_01KQ…8TZ2",
    lastRun: "10:05 today",
  },
  {
    id: "phb-estimate-population",
    name: "Estimate population",
    live: "v2.3.1",
    versions: ["v2.0.0", "v2.1.0", "v2.2.0", "v2.3.0", "v2.3.1"],
    anthropicId: "skill_01HR…2K9M",
    lastRun: "09:42 today",
  },
  {
    ...NONE,
    id: "phb-estimate-qa",
    name: "Estimate QA",
    live: null,
    versions: [],
    lastRun: "Never",
  },
  {
    ...NONE,
    id: "phb-jv-summary",
    name: "JV partner summary",
    live: "v1.0.0",
    versions: ["v1.0.0"],
    anthropicId: "skill_01JB…7XW4",
    lastRun: "Sep 12",
  },
  {
    ...NONE,
    id: "phb-legacy-import",
    name: "Legacy CE import",
    live: null,
    versions: ["v1.0.0"],
    lastRun: "Aug 2",
  },
];

export function getPlaceholderSkill(id: string): Skill | undefined {
  return PLACEHOLDER_SKILLS.find((s) => s.id === id);
}

const step = (skillId: string, name: string, version: string) => ({ skillId, name, version, mode: "live" as const });

export const PLACEHOLDER_SETTINGS_WORKFLOWS: Workflow[] = [
  {
    id: "kickoff-population",
    name: "Bid kickoff → Estimate population",
    description: "Runs kickoff, then populates the estimate from its outputs.",
    status: "Active",
    steps: [step("phb-bid-kickoff", "Bid kickoff", "v1.4.0"), step("phb-estimate-population", "Estimate population", "v2.3.1")],
    roles: ["pce", "cost-engineer"],
    runs30d: 38,
  },
  {
    id: "bid-kickoff",
    name: "Bid kickoff",
    description: "Reads the bid documents and drafts the kickoff summary.",
    status: "Active",
    steps: [step("phb-bid-kickoff", "Bid kickoff", "v1.4.0")],
    roles: ["pce", "cost-engineer", "estimator"],
    runs30d: 61,
  },
  {
    id: "estimate-population",
    name: "Estimate population",
    description: "Populates the estimate from an existing kickoff.",
    status: "Active",
    steps: [step("phb-estimate-population", "Estimate population", "v2.3.1")],
    roles: ["pce", "cost-engineer"],
    runs30d: 44,
  },
  {
    id: "jv-summary",
    name: "JV partner summary",
    description: "Summarises the estimate for a joint-venture partner.",
    status: "Active",
    steps: [step("phb-jv-summary", "JV partner summary", "v1.0.0")],
    roles: ["pce"],
    runs30d: 19,
  },
  {
    id: "estimate-qa",
    name: "Estimate QA",
    description: "Checks a finished estimate before it goes out.",
    status: "Draft",
    steps: [step("phb-estimate-qa", "Estimate QA", "main")],
    roles: ["pce"],
    runs30d: 0,
  },
];

export const CIP_ROLES: Role[] = [
  { id: "pce", name: "PCE" },
  { id: "cost-engineer", name: "Cost Engineer" },
  { id: "estimator", name: "Estimator" },
  { id: "viewer", name: "Viewer" },
];

export const CIP_PERMISSIONS: Permission[] = [
  { label: "View runs and outputs", roles: ["pce", "cost-engineer", "estimator", "viewer"] },
  { label: "Start runs", roles: ["pce", "cost-engineer", "estimator"] },
  { label: "Answer run decisions", roles: ["pce", "cost-engineer", "estimator"] },
  { label: "Open JV-partner outputs", roles: ["pce", "cost-engineer"] },
  { label: "Edit skills on Git main", roles: ["pce"] },
  { label: "Publish skills and workflows", roles: ["pce"] },
  { label: "Manage access and budget", roles: ["pce"] },
];

export const PLACEHOLDER_PEOPLE: Person[] = [
  { id: "p1", name: "Sample PCE", email: "pce@sample.invalid", role: "pce", lastActive: "Now" },
  { id: "p2", name: "Dana Whitfield", email: "dwhitfield@sample.invalid", role: "cost-engineer", lastActive: "10 min ago" },
  { id: "p3", name: "Marcus Reyes", email: "mreyes@sample.invalid", role: "cost-engineer", lastActive: "Today" },
  { id: "p4", name: "Priya Nair", email: "pnair@sample.invalid", role: "estimator", lastActive: "Yesterday" },
  { id: "p5", name: "Tom Keller", email: "tkeller@sample.invalid", role: "estimator", lastActive: "Sep 24" },
  { id: "p6", name: "Alana Brooks", email: "abrooks@sample.invalid", role: "viewer", lastActive: "Sep 19" },
];

// A repeating daily shape, scaled so the days add up to the range's spend.
const SHAPE = [4, 10, 4, 10, 6, 7, 5, 8, 8, 7, 9, 6, 7, 1, 10, 5, 9, 7, 8, 6, 5, 9, 7, 9, 5, 10, 1, 7, 6, 9];

function usage(bySkill: Usage["bySkill"], count: number): Usage {
  const total = bySkill.reduce((a, s) => a + s.spend, 0);
  const weights = Array.from({ length: count }, (_, i) => SHAPE[i % SHAPE.length] ?? 1);
  const sum = weights.reduce((a, b) => a + b, 0);
  const end = new Date(2026, 8, 30);
  const days = weights.map((w, i) => {
    const d = new Date(end);
    d.setDate(end.getDate() - (count - 1 - i));
    return { date: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }), spend: Math.round((w / sum) * total) };
  });
  return { days, bySkill };
}

export const PLACEHOLDER_USAGE: Record<UsageRange, Usage> = {
  "7d": usage(
    [
      { skill: "phb-estimate-population", runs: 15, tokens: 8_300_000, spend: 136 },
      { skill: "phb-bid-kickoff", runs: 19, tokens: 4_100_000, spend: 67 },
      { skill: "phb-jv-summary", runs: 6, tokens: 1_900_000, spend: 32 },
    ],
    7,
  ),
  "30d": usage(
    [
      { skill: "phb-estimate-population", runs: 62, tokens: 34_200_000, spend: 569 },
      { skill: "phb-bid-kickoff", runs: 75, tokens: 16_500_000, spend: 275 },
      { skill: "phb-jv-summary", runs: 25, tokens: 8_200_000, spend: 137 },
    ],
    30,
  ),
  quarter: usage(
    [
      { skill: "phb-estimate-population", runs: 171, tokens: 94_000_000, spend: 1562 },
      { skill: "phb-bid-kickoff", runs: 204, tokens: 45_100_000, spend: 748 },
      { skill: "phb-jv-summary", runs: 70, tokens: 22_300_000, spend: 371 },
    ],
    90,
  ),
};

export const PLACEHOLDER_BUDGET: Budget = { month: "September", limit: 1500, spent: 981, alertAt: 0.8 };
