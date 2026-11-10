import "./load-env";

/**
 * Measures Knowledge Base search against questions whose answer you know.
 *
 *   npm run kb:eval                          .kb-eval/questions.json
 *   npm run kb:eval -- --file <path>         another set
 *   npm run kb:eval -- --show 3              also print the top 3 files per question
 *   npm run kb:eval -- --mode keyword        one search only (keyword | hybrid);
 *                                            the default runs both, side by side
 *
 * The file is a JSON array:
 *
 *   [{ "question": "What CFM are the air valves?",
 *      "expect": ["224070_SUB_Air_Valves"],      // file names (or their start) that hold the answer
 *      "note": "optional, for you" }]
 *
 * A question is FOUND at rank N when the Nth distinct file in the results
 * starts with (or equals) one of `expect`, ignoring case and an ARCHIVE_
 * prefix. A file listed under a result as holding the same text ("also in")
 * counts at that result's rank. Reported: found in the top 1, top 5, and mean reciprocal rank.
 *
 * The question set describes real projects, so it lives in .kb-eval/, which
 * git ignores. Run it before and after a change to search (and when
 * embeddings arrive) and compare the totals.
 */

type Question = { question: string; expect: string[]; note?: string };

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

const normal = (name: string) => name.toLowerCase().replace(/^archive_/, "");

async function main() {
  const { readFile } = await import("node:fs/promises");
  const { searchPassages } = await import("../lib/modules/knowledge-base/search");
  const { prisma } = await import("../lib/db");

  const file = arg("--file") ?? ".kb-eval/questions.json";
  const show = Number(arg("--show") ?? "0");
  const only = arg("--mode");
  if (only !== null && only !== "keyword" && only !== "hybrid") throw new Error("--mode is keyword or hybrid.");
  const modes = (only ? [only] : ["keyword", "hybrid"]) as ("keyword" | "hybrid")[];
  const questions = JSON.parse(await readFile(file, "utf8")) as Question[];

  const totals = Object.fromEntries(modes.map((m) => [m, { top1: 0, top5: 0, rr: 0, ran: m as string }]));
  // One entry per distinct result file: its name, then the files holding the same text.
  const rankIn = (files: string[][], q: Question) => {
    const wanted = q.expect.map(normal);
    return files.findIndex((names) => names.some((f) => wanted.some((w) => normal(f).startsWith(w)))) + 1;
  };
  const label = (rank: number) => (rank === 0 ? "missed" : `rank ${rank}`).padEnd(8);

  try {
    console.log(`     ${modes.map((m) => m.padEnd(8)).join(" ")} question`);
    for (const [i, q] of questions.entries()) {
      const ranks: number[] = [];
      const lists: string[][][] = [];
      for (const mode of modes) {
        const result = await searchPassages({ query: q.question, limit: 50, mode });
        const files: string[][] = [];
        for (const hit of result.hits) {
          if (!files.some((names) => names[0] === hit.fileName)) {
            files.push([hit.fileName, ...hit.alsoIn.map((c) => c.fileName)]);
          }
        }
        const rank = rankIn(files, q);
        const t = totals[mode]!;
        if (rank === 1) t.top1 += 1;
        if (rank >= 1 && rank <= 5) t.top5 += 1;
        if (rank >= 1) t.rr += 1 / rank;
        if (result.mode !== mode) t.ran = `${mode} (ran as ${result.mode}: ${result.notice ?? ""})`;
        ranks.push(rank);
        lists.push(files);
      }
      console.log(`${String(i + 1).padStart(2)}.  ${ranks.map(label).join(" ")} ${q.question}`);
      const last = lists.at(-1) ?? [];
      if (show > 0 || ranks.at(-1) === 0) {
        for (const [first, ...copies] of last.slice(0, Math.max(show, ranks.at(-1) === 0 ? 3 : 0))) {
          console.log(`        ${first}${copies.length > 0 ? ` (same text also in ${copies.length} more)` : ""}`);
        }
        if (last.length === 0) console.log("        (nothing found)");
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  const n = questions.length || 1;
  console.log("");
  for (const mode of modes) {
    const t = totals[mode]!;
    console.log(
      `${t.ran.padEnd(8)} ${questions.length} questions · top 1: ${t.top1} (${Math.round((100 * t.top1) / n)}%) · ` +
        `top 5: ${t.top5} (${Math.round((100 * t.top5) / n)}%) · MRR ${(t.rr / n).toFixed(2)}`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
