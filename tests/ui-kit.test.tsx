import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import * as kit from "@/components/ui";
import * as CipButton from "@/app/(modules)/cost-intelligence/ui/Button";
import * as CipCard from "@/app/(modules)/cost-intelligence/ui/Card";
import * as CipDropdown from "@/app/(modules)/cost-intelligence/ui/Dropdown";
import * as CipFilterMenu from "@/app/(modules)/cost-intelligence/ui/FilterMenu";
import * as CipLabel from "@/app/(modules)/cost-intelligence/ui/Label";
import * as CipLinkPending from "@/app/(modules)/cost-intelligence/ui/LinkPending";
import * as CipPill from "@/app/(modules)/cost-intelligence/ui/Pill";
import * as CipSegmented from "@/app/(modules)/cost-intelligence/ui/Segmented";
import * as CipTable from "@/app/(modules)/cost-intelligence/ui/Table";
import * as FpField from "@/app/(modules)/freeze-protection/ui/Field";
import * as FpKit from "@/app/(modules)/freeze-protection/ui/kit";

/**
 * The shared UI kit (components/ui, 2026-11-10), held to the three things that
 * made promoting it safe:
 *
 *   1. The module paths are the kit. Cost Intelligence and Freeze Protection
 *      still import from their own `ui/`, and what they get IS the kit's
 *      function - not a copy that can drift.
 *   2. The kit renders what Cost Intelligence rendered. The class SETS of the
 *      defaults are pinned to the strings the module shipped with; order is
 *      free, membership is not.
 *   3. The kit knows no colour and no module. Every value is a token; there is
 *      no hex, no module key and no import from a module's library.
 *
 * Render-level, not screenshot-level: the before/after screenshots in the
 * promoting PR are the visual record, this is what keeps it true afterwards.
 *
 * Rendered with JSX rather than createElement, unlike the older rendering
 * tests: every kit component declares `children` as required, createElement's
 * overloads want it inside the props object, and react/no-children-prop
 * refuses it there. JSX is the one form the type and the rule both accept,
 * with no cast at the call site.
 */

const ROOT = path.resolve(__dirname, "..");
const KIT_DIR = path.join(ROOT, "components/ui");

function html(element: ReactElement): string {
  return renderToStaticMarkup(element);
}

/** The class attribute of the outermost element, as a set. */
function classSet(markup: string): Set<string> {
  const match = /^<[a-z]+[^>]*?class="([^"]*)"/.exec(markup);
  if (match === null) throw new Error(`no class attribute on ${markup.slice(0, 80)}`);
  return new Set(match[1]!.split(/\s+/).filter((c) => c.length > 0));
}

function tokens(classes: string): Set<string> {
  return new Set(classes.split(/\s+/).filter((c) => c.length > 0));
}

describe("the module paths are the kit", () => {
  it("Cost Intelligence re-exports the kit's own functions", () => {
    expect(CipButton.Button).toBe(kit.Button);
    expect(CipCard.Card).toBe(kit.Card);
    expect(CipDropdown.Dropdown).toBe(kit.Dropdown);
    expect(CipFilterMenu.FilterMenu).toBe(kit.FilterMenu);
    expect(CipLabel.Label).toBe(kit.Label);
    expect(CipLinkPending.LinkPending).toBe(kit.LinkPending);
    expect(CipPill.Pill).toBe(kit.Pill);
    expect(CipSegmented.Segmented).toBe(kit.Segmented);
    expect(CipTable.Table).toBe(kit.Table);
  });

  it("Freeze Protection re-exports the kit's own functions, fields included", () => {
    expect(FpKit.Button).toBe(kit.Button);
    expect(FpKit.Card).toBe(kit.Card);
    expect(FpKit.Empty).toBe(kit.Empty);
    expect(FpKit.Label).toBe(kit.Label);
    expect(FpKit.LinkPending).toBe(kit.LinkPending);
    expect(FpField.INPUT).toBe(kit.INPUT);
    expect(FpField.FieldLabel).toBe(kit.FieldLabel);
    expect(FpField.TextField).toBe(kit.TextField);
    expect(FpField.TextArea).toBe(kit.TextArea);
    expect(FpField.DateField).toBe(kit.DateField);
    expect(FpField.NumberField).toBe(kit.NumberField);
    expect(FpField.SelectField).toBe(kit.SelectField);
    expect(FpField.YesNo).toBe(kit.YesNo);
  });

  it("Freeze Protection's tone words render the kit's tones, byte for byte", () => {
    // open is the kit's purple (draft), closed its neutral (muted); the other three share a name.
    const pairs: Array<[Parameters<typeof FpKit.Pill>[0]["tone"], kit.Tone]> = [
      ["ok", "ok"],
      ["warn", "warn"],
      ["bad", "bad"],
      ["open", "draft"],
      ["closed", "muted"],
    ];
    for (const [fp, shared] of pairs) {
      expect(html(<FpKit.Pill tone={fp}>x</FpKit.Pill>)).toBe(html(<kit.Pill tone={shared}>x</kit.Pill>));
      expect(html(<FpKit.Callout tone={fp} lead="Lead.">x</FpKit.Callout>)).toBe(
        html(<kit.Callout tone={shared} lead="Lead.">x</kit.Callout>),
      );
    }
  });
});

describe("the kit renders what Cost Intelligence rendered", () => {
  // The strings the module shipped with (app/(modules)/cost-intelligence/ui, PR #64),
  // before the kit was promoted. Membership is what the browser sees.
  const CIP_BUTTON_BASE =
    "inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-[var(--radius-control)] px-4 text-[0.8125rem] font-medium transition-opacity disabled:pointer-events-none disabled:opacity-50";
  const CIP_BUTTON_PRIMARY = "bg-[var(--phb-red-btn)] text-white hover:opacity-90";
  const CIP_BUTTON_SECONDARY =
    "border border-[var(--border)] bg-white text-[var(--foreground)] hover:bg-[var(--neutral-50)]";

  it("a secondary button, the default, and a primary one", () => {
    expect(classSet(html(<kit.Button>Go</kit.Button>))).toEqual(tokens(`${CIP_BUTTON_BASE} ${CIP_BUTTON_SECONDARY}`));
    expect(classSet(html(<kit.Button variant="primary">Go</kit.Button>))).toEqual(
      tokens(`${CIP_BUTTON_BASE} ${CIP_BUTTON_PRIMARY}`),
    );
    expect(classSet(html(<kit.Button fullWidth>Go</kit.Button>))).toEqual(
      tokens(`${CIP_BUTTON_BASE} ${CIP_BUTTON_SECONDARY} w-full`),
    );
    // A button with no title renders no title attribute, as before.
    expect(html(<kit.Button>Go</kit.Button>)).not.toContain("title=");
    // An href renders a link, the pending spinner inside it idle.
    const link = html(<kit.Button href="/x">Go</kit.Button>);
    expect(link).toMatch(/^<a [^>]*href="\/x"/);
    expect(link).toContain(">Go</a>");
  });

  it("the small size and the danger variant are additions, not changes", () => {
    const small = classSet(html(<kit.Button size="sm">Go</kit.Button>));
    expect(small.has("h-7")).toBe(true);
    expect(small.has("h-9")).toBe(false);
    const danger = classSet(html(<kit.Button variant="danger">Go</kit.Button>));
    expect(danger.has("text-[var(--danger)]")).toBe(true);
    expect(danger.has("bg-white")).toBe(true);
  });

  it("a pill in each of Cost Intelligence's four tones, and the fifth from Freeze Protection", () => {
    const base = "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[0.6875rem] font-medium";
    const tones: Record<kit.Tone, string> = {
      ok: "bg-[color-mix(in_srgb,var(--phb-teal)_22%,transparent)] text-[var(--phb-teal-ink)]",
      draft: "bg-[color-mix(in_srgb,var(--phb-purple)_12%,transparent)] text-[var(--phb-purple)]",
      muted: "bg-[var(--neutral-100)] text-[var(--muted)]",
      warn: "bg-[color-mix(in_srgb,var(--phb-orange)_20%,transparent)] text-[var(--phb-orange-ink)]",
      bad: "bg-[color-mix(in_srgb,var(--phb-maroon)_12%,transparent)] text-[var(--phb-maroon)]",
    };
    for (const tone of Object.keys(tones) as kit.Tone[]) {
      expect(classSet(html(<kit.Pill tone={tone}>x</kit.Pill>))).toEqual(tokens(`${base} ${tones[tone]}`));
    }
  });

  it("a card, a label and an empty state", () => {
    expect(html(<kit.Card>x</kit.Card>)).toBe('<div class="card p-5 ">x</div>');
    expect(html(<kit.Card padding="p-3" className="flex">x</kit.Card>)).toBe('<div class="card p-3 flex">x</div>');
    expect(html(<kit.Label>x</kit.Label>)).toBe('<p class="eyebrow mb-3 text-[var(--muted)]">x</p>');
    expect(classSet(html(<kit.Empty>x</kit.Empty>))).toEqual(
      tokens("flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-[0.8125rem] text-[var(--muted)]"),
    );
  });

  it("a segmented control, dark by default, and the same strip stretched", () => {
    const options = [
      { value: "a", label: "A" },
      { value: "b", label: "B" },
    ];
    const dark = html(<kit.Segmented options={options} value="a" onChange={() => {}} label="Pick" />);
    expect(classSet(dark)).toEqual(tokens("inline-flex rounded-[var(--radius-control)] p-0.5 border border-[var(--border)] bg-white"));
    expect(dark).toContain('role="radiogroup"');
    expect(dark).toContain('aria-checked="true"');
    const on = /<button[^>]*aria-checked="true"[^>]*class="([^"]*)"/.exec(dark);
    expect(tokens(on![1]!)).toEqual(
      tokens("rounded-[calc(var(--radius-control)-2px)] px-3 py-1.5 text-[0.8125rem] transition-colors bg-[var(--neutral-900)] font-medium text-white"),
    );

    const wide = html(
      <kit.Segmented options={options} value="a" onChange={() => {}} label="Pick" tone="light" fullWidth />,
    );
    expect(classSet(wide)).toEqual(tokens("flex w-full rounded-[var(--radius-control)] p-0.5 bg-[var(--neutral-100)]"));
    expect(wide.match(/flex-1/g)).toHaveLength(2);
  });

  it("the one input class string Freeze Protection's fields were built on", () => {
    expect(kit.INPUT).toBe(
      "h-9 w-full rounded-[var(--radius-control)] border border-[var(--border)] bg-white px-3 text-[0.8125rem] text-[var(--foreground)] focus:border-[var(--module-accent)] focus:outline-none disabled:opacity-60",
    );
  });

  it("a tab bar: the nav, one link per tab, aria-current on the active one, actions on the right", () => {
    const markup = html(
      <kit.TabBar
        label="Example sections"
        tabs={[
          { href: "/a", label: "A", active: true },
          { href: "/b", label: "B (3)", active: false },
        ]}
        actions={<span id="act">act</span>}
      />,
    );
    expect(markup).toContain('<nav aria-label="Example sections"');
    expect(markup.match(/<a /g)).toHaveLength(2);
    expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
    expect(markup).toMatch(/aria-current="page"[^>]*style="border-color:var\(--module-accent\)"[^>]*>A</);
    expect(markup).toContain(">B (3)</a>");
    expect(markup).toContain('<span id="act">act</span>');
    // No actions, no empty actions box.
    const bare = html(<kit.TabBar label="X" tabs={[]} />);
    expect(bare).not.toContain("gap-2");
  });
});

describe("the kit knows no colour and no module", () => {
  async function kitSources(): Promise<Array<{ file: string; text: string }>> {
    const entries = await readdir(KIT_DIR);
    const files = entries.filter((name) => /\.tsx?$/.test(name));
    expect(files.length).toBeGreaterThanOrEqual(14);
    return Promise.all(
      files.map(async (name) => ({ file: `components/ui/${name}`, text: await readFile(path.join(KIT_DIR, name), "utf8") })),
    );
  }

  it("names no raw colour: every value is a token from app/globals.css", async () => {
    for (const { file, text } of await kitSources()) {
      expect(text, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(text, file).not.toMatch(/\brgba?\(/);
      expect(text, file).not.toMatch(/\bhsla?\(/);
      // Tailwind's own palette would be a colour decided outside the tokens.
      expect(text, file).not.toMatch(/\b(?:bg|text|border|ring)-(?:red|amber|blue|green|slate|gray|zinc|purple|teal|orange)-\d{2,3}\b/);
    }
  });

  it("names no module and imports nothing from a module's library", async () => {
    for (const { file, text } of await kitSources()) {
      for (const key of ["change-orders", "cost-intelligence", "freeze-protection", "knowledge-base", '"bas"']) {
        expect(text, `${file} mentions ${key}`).not.toContain(key);
      }
      expect(text, file).not.toMatch(/from\s+["']@\/lib\/modules\//);
      expect(text, file).not.toMatch(/from\s+["']@\/app\//);
    }
  });
});

describe("the Change Orders chrome is drawn with the kit", () => {
  const CHROME = ["co-shell.tsx", "states.tsx", "mailbox-workspace.tsx", "review-workspace.tsx", "message-actions.tsx"];

  it("imports the kit in every chrome file", async () => {
    for (const name of CHROME) {
      const text = await readFile(path.join(ROOT, "app/(modules)/change-orders", name), "utf8");
      expect(text, name).toMatch(/from "@\/components\/ui"/);
    }
  });

  it("keeps the reading pane, the editor and the attachment flow off the kit, as the 2026-11-10 pass decided", async () => {
    // Chrome only, that pass. If one of these starts importing the kit it is a
    // decision to record in WHY-ITS-BUILT-THIS-WAY.md § 78, not an accident.
    for (const name of ["draft-editor.tsx", "body-editor.tsx", "message-body.tsx", "attachments.tsx"]) {
      const text = await readFile(path.join(ROOT, "app/(modules)/change-orders", name), "utf8");
      expect(text, name).not.toMatch(/from "@\/components\/ui/);
    }
  });
});
