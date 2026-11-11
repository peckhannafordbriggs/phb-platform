import "./load-env";
import { readFileSync } from "node:fs";
import { renderReportHtml } from "../lib/modules/bas/reports/engine/html";
import type { ReportDocument } from "../lib/modules/bas/reports/engine/types";

/**
 * Render one report document to the standalone HTML page, exactly as a run
 * stores it (Reports, Phase 2) - the same `renderReportHtml` the engine
 * calls, loaded the same way `bas:report:run` is loaded (tsx, this
 * repository's tsconfig).
 *
 *   npm run -s bas:report:render -- <document.json>   > report.html
 *   psql ... -At -c "select report_json from bas_report_runs where run_id = 2" | npm run -s bas:report:render > report.html
 *
 * The document is the `report_json` column of `bas_report_runs`, read from
 * the file named or from stdin. The HTML goes to stdout and nothing else
 * does, so it can be redirected to a file and opened.
 *
 * It exists for two reasons. A person can look at a stored run without the
 * platform (the run page renders the same component). And
 * `tests/bas-reports-worker-render.test.ts` drives it to prove the template
 * renders under the worker's loader, which compiles JSX differently from
 * Next and from vitest: run 1 on the development database failed with
 * "React is not defined" on 2026-11-10 for exactly that reason, and no
 * in-process test could have seen it.
 */
function main(): void {
  const file = process.argv[2];
  const text = file !== undefined ? readFileSync(file, "utf8") : readFileSync(0, "utf8");
  const document = JSON.parse(text) as ReportDocument;
  process.stdout.write(renderReportHtml(document));
}

main();
