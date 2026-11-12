import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderReportHtml } from "@/lib/modules/bas/reports/engine/html";
import { reportDocument } from "./fixtures/bas-report-document";

/**
 * The report template under the WORKER'S loader, not vitest's.
 *
 * Three things compile `engine/render.tsx`: Next (its own SWC transform),
 * vitest (oxc, `jsx.runtime: "automatic"` in vitest.config.mts) and the dev
 * script `bas:report:run` under tsx - esbuild reading this repository's
 * tsconfig, whose `jsx: "preserve"` esbuild takes as the CLASSIC transform,
 * `React.createElement(...)`, with no React in scope. Run 1 on the
 * development database (2026-11-10 11:48) failed with "React is not
 * defined" for exactly that reason, and every in-process test passed,
 * because vitest never compiles the file the way the worker does. The
 * template now names its runtime in a pragma on line 1; this test is what
 * sees that pragma go missing, or a second .tsx file arrive without one.
 *
 * So the test spawns tsx itself, from the repository root (where tsx finds
 * the same tsconfig the npm script finds), on the render script the engine's
 * `renderReportHtml` is reached through, and compares the HTML byte for
 * byte with the one vitest's own loader produces from the same document.
 */

const ROOT = path.resolve(__dirname, "..");
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const RENDER_SCRIPT = path.join("scripts", "bas-report-render.ts");
const TEMPLATE = path.join(ROOT, "lib", "modules", "bas", "reports", "engine", "render.tsx");

function renderUnderTsx(documentJson: string): string {
  return execFileSync(process.execPath, [TSX_CLI, RENDER_SCRIPT], {
    cwd: ROOT,
    env: process.env,
    input: documentJson,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
}

describe("the report template under the worker's loader", () => {
  it("renders the standalone HTML through bas:report:render, byte for byte what vitest renders", () => {
    const document = reportDocument();
    const html = renderUnderTsx(JSON.stringify(document));

    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("PHB Steel Place BAS Health Report");
    expect(html).toContain("VAV-2-14");
    expect(html).toContain("read -40 °F");
    expect(html).not.toContain("React is not defined");
    // The same component, the same document, two loaders: one page.
    expect(html).toBe(renderReportHtml(document));
  }, 60_000);

  it("is not vacuous: the same template without its runtime pragma fails under tsx with the stored run's error", () => {
    // A copy of render.tsx with line 1 - the pragma - removed, outside the
    // repository so nothing imports it by accident, its two relative imports
    // pointed back at the engine. tsx applies the repository's tsconfig to a
    // file outside it when run from the repository (checked 2026-11-11), and
    // NODE_PATH lets the copy find react.
    const dir = mkdtempSync(path.join(tmpdir(), "phb-report-template-"));
    try {
      const source = readFileSync(TEMPLATE, "utf8").split(/\r?\n/);
      expect(source[0]).toMatch(/^\/\*\* @jsxRuntime automatic @jsxImportSource react \*\//);
      const engine = path.dirname(TEMPLATE).replace(/\\/g, "/");
      const reports = path.dirname(engine);
      // Every relative import pointed back at the engine, whatever the
      // template imports this week.
      const stripped = source
        .slice(1)
        .join("\n")
        .replace(/from "\.\/([^"]+)"/g, (_, rel: string) => `from "${engine}/${rel}"`)
        .replace(/from "\.\.\/([^"]+)"/g, (_, rel: string) => `from "${reports}/${rel}"`);
      writeFileSync(path.join(dir, "render-without-pragma.tsx"), stripped);
      writeFileSync(
        path.join(dir, "entry.ts"),
        [
          'import { readFileSync } from "node:fs";',
          'import { createElement } from "react";',
          'import { renderToStaticMarkup } from "react-dom/server";',
          'import { ReportView } from "./render-without-pragma";',
          'const document = JSON.parse(readFileSync(0, "utf8"));',
          "process.stdout.write(renderToStaticMarkup(createElement(ReportView, { document })));",
          "",
        ].join("\n"),
      );

      const result = spawnSync(process.execPath, [TSX_CLI, path.join(dir, "entry.ts")], {
        cwd: ROOT,
        env: { ...process.env, NODE_PATH: path.join(ROOT, "node_modules") },
        input: JSON.stringify(reportDocument()),
        encoding: "utf8",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("React is not defined");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
