import "./load-env";

/**
 * Measures Knowledge Base search against questions whose answer you know.
 *
 *   npm run kb:eval                          .kb-eval/questions.json
 *   npm run kb:eval -- --file <path>         another set
 *   npm run kb:eval -- --show 3              also print the top 3 files per question
 *
 * The file is a JSON array:
 *
 *   [{ "question": "What CFM are the air valves?",
 *      "expect": ["224070_SUB_Air_Valves"],      // file names (or their start) that hold the answer
 *      "note": "optional, for you" }]
 *
 * A question is FOUND at rank N when the Nth distinct file in the results
 * starts with (or equals) one of `expect`, ignoring case and an ARCHIVE_
 * prefix. Reported: found in the top 1, top 5, and mean reciprocal rank.
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
  const questions = JSON.parse(await readFile(file, "utf8")) as Question[];

  let top1 = 0;
  let top5 = 0;
  let rr = 0;
  try {
    for (const [i, q] of questions.entries()) {
      const result = await searchPassages({ query: q.question, limit: 50 });
      const files: string[] = [];
      for (const hit of result.hits) if (!files.includes(hit.fileName)) files.push(hit.fileName);
      const wanted = q.expect.map(normal);
      const rank = files.findIndex((f) => wanted.some((w) => normal(f).startsWith(w))) + 1;
      if (rank === 1) top1 += 1;
      if (rank >= 1 && rank <= 5) top5 += 1;
      if (rank >= 1) rr += 1 / rank;
      const verdict = rank === 0 ? "MISSED " : `rank ${String(rank).padEnd(3)}`;
      console.log(`${String(i + 1).padStart(2)}. ${verdict} ${q.question}`);
      if (show > 0 || rank === 0) {
        for (const f of files.slice(0, Math.max(show, rank === 0 ? 3 : 0))) console.log(`        ${f}`);
        if (files.length === 0) console.log(`        (nothing matched: ${result.terms.join(", ") || "no searchable words"})`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  const n = questions.length || 1;
  console.log(
    `\n${questions.length} questions · top 1: ${top1} (${Math.round((100 * top1) / n)}%) · ` +
      `top 5: ${top5} (${Math.round((100 * top5) / n)}%) · MRR ${(rr / n).toFixed(2)}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
