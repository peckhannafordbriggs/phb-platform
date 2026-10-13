import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getUsage, parseUsageRange } from "@/lib/modules/cost-intelligence/usage";
import { createEmployee, disconnectDb, resetDb, testDb } from "./db";

// Noon in New York on Oct 13, 2026.
const NOW = new Date("2026-10-13T16:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

let actor: string;

async function run(project: string, workflow: string, steps: string[], costs: { step: number; cost: number; at: Date }[]) {
  const p = await testDb.cipProject.upsert({
    where: { folderName: project },
    create: { folderName: project, locationPath: "x", fileCount: 1, totalBytes: 1n, lastSynced: NOW },
    update: {},
  });
  const wf = await testDb.cipWorkflow.create({ data: { name: `${workflow} ${Math.random()}`, status: "active" } });
  const r = await testDb.cipRun.create({
    data: {
      workflowId: wf.id,
      workflowName: workflow,
      projectId: p.id,
      steps: steps.map((folderName) => ({ folderName, name: folderName, version: 1 })),
      model: "m",
      budgetUsd: 5,
      startedById: actor,
      status: "succeeded",
    },
  });
  for (const c of costs) {
    await testDb.cipRunEvent.create({
      data: { runId: r.id, step: c.step, type: "step_cost", message: "", data: { cost: c.cost, input: 1000, output: 100 }, at: c.at },
    });
  }
  return r.id.toString();
}

beforeEach(async () => {
  await resetDb();
  actor = (await createEmployee()).id;
});
afterAll(disconnectDb);

describe("getUsage", () => {
  it("totals spend, runs and tokens in the range, and breaks it down by skill, project and workflow", async () => {
    const a = await run("Anderson", "Kickoff", ["phb-bid-kickoff", "phb-bid-tab"], [
      { step: 0, cost: 1.2, at: daysAgo(1) },
      { step: 1, cost: 0.5, at: daysAgo(1) },
    ]);
    await run("Rookwood", "Kickoff", ["phb-bid-kickoff"], [{ step: 0, cost: 2, at: daysAgo(3) }]);
    await run("Rookwood", "Old", ["phb-bid-tab"], [{ step: 0, cost: 9, at: daysAgo(40) }]); // outside 30 days

    const usage = await getUsage("30d", NOW);

    expect(usage.totals.runs).toBe(2);
    expect(usage.totals.spend).toBeCloseTo(3.7);
    expect(usage.totals.tokens).toBe(3 * 1100);
    expect(usage.bySkill).toEqual([
      { label: "phb-bid-kickoff", runs: 2, tokens: 2200, spend: 3.2 },
      { label: "phb-bid-tab", runs: 1, tokens: 1100, spend: 0.5 },
    ]);
    expect(usage.byProject.map((r) => [r.label, r.runs])).toEqual([["Rookwood", 1], ["Anderson", 1]]);
    expect(usage.byWorkflow).toEqual([{ label: "Kickoff", runs: 2, tokens: 3300, spend: expect.closeTo(3.7) }]);
    expect(usage.topRuns.map((r) => r.projectName)).toEqual(["Rookwood", "Anderson"]);
    expect(usage.topRuns[1]).toMatchObject({ id: a, spend: expect.closeTo(1.7), status: "succeeded" });
  });

  it("fills every day of the range, oldest first, ending today in New York", async () => {
    await run("Anderson", "Kickoff", ["phb-bid-kickoff"], [{ step: 0, cost: 1, at: daysAgo(1) }]);
    // 11pm on Oct 12 in New York is already Oct 13 in UTC; it belongs to the 12th.
    await run("Anderson", "Kickoff", ["phb-bid-kickoff"], [{ step: 0, cost: 2, at: new Date("2026-10-13T03:00:00Z") }]);

    const { days } = await getUsage("7d", NOW);

    expect(days).toHaveLength(7);
    expect(days[0]).toMatchObject({ date: "2026-10-07", label: "Oct 7" });
    expect(days.at(-1)).toMatchObject({ date: "2026-10-13", spend: 0 });
    expect(days.find((d) => d.date === "2026-10-12")?.spend).toBe(3);
  });

  it("reports this month's spend whatever the range, and nothing when there are no runs", async () => {
    await run("Anderson", "Kickoff", ["phb-bid-kickoff"], [{ step: 0, cost: 4, at: daysAgo(10) }]);
    await run("Anderson", "Kickoff", ["phb-bid-kickoff"], [{ step: 0, cost: 6, at: daysAgo(20) }]); // September

    expect((await getUsage("7d", NOW)).thisMonth).toEqual({ label: "October", spend: 4 });
    expect((await getUsage("7d", NOW)).totals).toEqual({ runs: 0, tokens: 0, spend: 0 });
  });

  it("falls back to 30 days for an unknown range", () => {
    expect(parseUsageRange("90d")).toBe("90d");
    expect(parseUsageRange("quarter")).toBe("30d");
    expect(parseUsageRange(undefined)).toBe("30d");
  });
});
