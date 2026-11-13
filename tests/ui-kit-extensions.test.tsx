import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as kit from "@/components/ui";

/**
 * What the BAS restyle added to the kit (2026-11-10), each an addition that
 * leaves the defaults tests/ui-kit.test.tsx pins exactly as they were:
 *
 *   - TabBar: a tab may name its own accent for the active underline.
 *   - Segmented: `semantics="pressed"` announces a toggle group, and an
 *     `accent` tone paints the chosen option in the platform accent.
 *   - Dropdown: `disabled`, and a combobox button that owns a listbox.
 *   - SearchBar: a filter mode that needs no router, and `hotkey={false}`.
 *   - Button: `testId`, `ariaExpanded` and `ariaLabel` pass through.
 *
 * And what the Admin Employees restyle added (2026-11-13), the same way:
 *
 *   - Table: `columns` for unequal widths and `detail` for a panel under an
 *     expanded row. Its default markup is pinned byte for byte to what it
 *     rendered before, so every table drawn before draws the same.
 *   - Switch: an on / off control, `role="switch"`, the accent when on.
 */

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("Table", () => {
  // Rendered from main at 107c318 (2026-11-13), before `columns` and `detail` existed.
  const BASE =
    '<div><div class="grid gap-4 border-b border-[var(--border)] pb-3" style="grid-template-columns:repeat(2, minmax(0, 1fr))"><span class="eyebrow text-[var(--muted)]">A</span><span class="eyebrow text-[var(--muted)]">B</span></div><div class="grid items-center gap-4 border-b border-[var(--divider-soft)] py-3.5 text-[0.8125rem] " style="grid-template-columns:repeat(2, minmax(0, 1fr))"><div class="min-w-0 truncate">1</div><div class="min-w-0 truncate">2</div></div><div class="grid items-center gap-4 border-b border-[var(--divider-soft)] py-3.5 text-[0.8125rem] " style="grid-template-columns:repeat(2, minmax(0, 1fr))"><div class="min-w-0 truncate">3</div><div class="min-w-0 truncate">4</div></div></div>';
  const BASE_PAGED =
    '<div><div class="grid gap-4 border-b border-[var(--border)] pb-3" style="grid-template-columns:repeat(2, minmax(0, 1fr))"><span class="eyebrow text-[var(--muted)]">A</span><span class="eyebrow text-[var(--muted)]">B</span></div><div class="grid items-center gap-4 border-b border-[var(--divider-soft)] py-3.5 text-[0.8125rem] cursor-pointer hover:bg-[var(--neutral-50)] bg-[var(--neutral-50)] font-medium" style="grid-template-columns:repeat(2, minmax(0, 1fr))"><div class="min-w-0 truncate">1</div><div class="min-w-0 truncate">2</div></div><div class="grid items-center gap-4 border-b border-[var(--divider-soft)] py-3.5 text-[0.8125rem] cursor-pointer hover:bg-[var(--neutral-50)] " style="grid-template-columns:repeat(2, minmax(0, 1fr))"><div class="min-w-0 truncate">3</div><div class="min-w-0 truncate">4</div></div><div class="flex items-center justify-end gap-3 pt-3 text-[0.8125rem] text-[var(--muted)]"><button type="button" disabled="" class="disabled:opacity-40">Previous</button><span>1 / 2</span><button type="button" class="disabled:opacity-40">Next</button></div></div>';

  const rows = [
    ["1", "2"],
    ["3", "4"],
  ];

  it("renders exactly what it rendered before the additions, with and without paging", () => {
    expect(html(<kit.Table headers={["A", "B"]} rows={rows} />)).toBe(BASE);
    expect(
      html(<kit.Table headers={["A", "B"]} rows={[...rows, ["5", "6"]]} pageSize={2} onRowClick={() => {}} selected={0} />),
    ).toBe(BASE_PAGED);
    // A detail function that has nothing to show changes nothing either.
    expect(html(<kit.Table headers={["A", "B"]} rows={rows} detail={() => null} />)).toBe(BASE);
  });

  it("takes a column template, and draws a panel under the one row that has a detail", () => {
    const markup = html(
      <kit.Table
        headers={["A", "B"]}
        rows={rows}
        columns="2rem minmax(0,1fr)"
        detail={(i) => (i === 1 ? <span id="panel">more</span> : null)}
      />,
    );
    expect(markup.match(/grid-template-columns:2rem minmax\(0,1fr\)/g)).toHaveLength(3);
    expect(markup).not.toContain("repeat(2, minmax(0, 1fr))");
    // One panel, after the second row and not the first.
    expect(markup.match(/<span id="panel">/g)).toHaveLength(1);
    const panelAt = markup.indexOf('id="panel"');
    expect(panelAt).toBeGreaterThan(markup.indexOf(">3</div>"));
    expect(markup.indexOf(">1</div>")).toBeLessThan(markup.indexOf(">3</div>"));
    expect(markup).toContain('class="rounded-[var(--radius-row)] bg-[var(--neutral-50)] px-4 py-4 text-[0.8125rem]"');
  });
});

describe("Switch", () => {
  it("is a switch, on in the accent and off in a neutral, its words the accessible name", () => {
    const on = html(<kit.Switch label="Access" checked onChange={() => {}} />);
    expect(on).toMatch(/^<button type="button" role="switch" aria-checked="true"/);
    expect(on).toContain("bg-[var(--module-accent)]");
    expect(on).toContain("translate-x-4");
    expect(on).toContain(">Access</span>");
    expect(on).not.toMatch(/ disabled=""/);

    const off = html(<kit.Switch label="Access" checked={false} onChange={() => {}} disabled description="Not yet" />);
    expect(off).toContain('aria-checked="false"');
    expect(off).toContain("bg-[var(--neutral-300)]");
    expect(off).not.toContain("translate-x-4");
    expect(off).toMatch(/<button[^>]*disabled=""/);
    expect(off).toContain(">Not yet</span>");
  });
});

describe("TabBar", () => {
  it("underlines the active tab in its own accent when it names one, and the module's otherwise", () => {
    const markup = html(
      <kit.TabBar
        label="Sections"
        tabs={[
          { href: "/a", label: "A", active: false },
          { href: "/b", label: "B", active: true, accent: "var(--phb-purple)" },
        ]}
      />,
    );
    expect(markup).toMatch(/aria-current="page"[^>]*style="border-color:var\(--phb-purple\)"/);
    const plain = html(<kit.TabBar label="Sections" tabs={[{ href: "/b", label: "B", active: true }]} />);
    expect(plain).toMatch(/aria-current="page"[^>]*style="border-color:var\(--module-accent\)"/);
  });
});

describe("Segmented", () => {
  const options = [
    { value: "a", label: "A" },
    { value: "b", label: "B" },
  ];

  it("is a radio group by default and a pressed-button group on request", () => {
    const radio = html(<kit.Segmented options={options} value="a" onChange={() => {}} label="Pick" />);
    expect(radio).toContain('role="radiogroup"');
    expect(radio).toContain('role="radio"');
    expect(radio).toContain('aria-checked="true"');
    expect(radio).not.toContain("aria-pressed");

    const pressed = html(
      <kit.Segmented options={options} value="b" onChange={() => {}} label="Show as" semantics="pressed" />,
    );
    expect(pressed).toContain('role="group" aria-label="Show as"');
    expect(pressed).not.toContain('role="radio"');
    expect(pressed).toMatch(/<button[^>]*aria-pressed="false"[^>]*>A<\/button>/);
    expect(pressed).toMatch(/<button[^>]*aria-pressed="true"[^>]*>B<\/button>/);
  });

  it("paints the chosen option in the platform accent on the accent tone", () => {
    const markup = html(<kit.Segmented options={options} value="a" onChange={() => {}} label="Range" tone="accent" />);
    expect(markup).toMatch(/<button[^>]*class="[^"]*bg-\[var\(--accent\)\][^"]*text-white[^"]*"[^>]*>A<\/button>/);
    expect(markup).not.toContain("bg-[var(--neutral-900)]");
  });
});

describe("Dropdown", () => {
  it("renders a combobox button that can be disabled, and no list until opened", () => {
    const markup = html(
      <kit.Dropdown label="Point" options={[{ value: "1", label: "One" }]} value="1" disabled placeholder="None" />,
    );
    expect(markup).toMatch(/<button[^>]*role="combobox"[^>]*disabled/);
    expect(markup).toContain('aria-haspopup="listbox"');
    expect(markup).toContain(">One<");
    expect(markup).not.toContain('role="listbox"');
  });
});

describe("SearchBar", () => {
  it("renders a filter box with no router, no result list, and the hint only when it owns the key", () => {
    // A node render has no app router; the live search needs one, the filter does not.
    const withKey = html(<kit.SearchBar label="Search points" placeholder="Search" value="" onChange={() => {}} />);
    expect(withKey).toContain('aria-label="Search points"');
    expect(withKey).toContain("<kbd");
    expect(withKey).not.toContain("combobox");
    expect(withKey).not.toContain('role="listbox"');

    const quiet = html(
      <kit.SearchBar label="Search points" placeholder="Search" value="rtu" onChange={() => {}} hotkey={false} />,
    );
    expect(quiet).not.toContain("<kbd");
    expect(quiet).toContain('value="rtu"');
    expect(quiet).toContain('aria-label="Clear search"');
  });
});

describe("Button", () => {
  it("passes a test id, an expanded state and an accessible name through, and nothing else new", () => {
    const markup = html(
      <kit.Button size="sm" testId="bas-download-csv" ariaExpanded={false} ariaLabel="Download the readings">
        Download
      </kit.Button>,
    );
    expect(markup).toContain('data-testid="bas-download-csv"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Download the readings"');
    const plain = html(<kit.Button>Go</kit.Button>);
    expect(plain).not.toContain("data-testid");
    expect(plain).not.toContain("aria-expanded");
    expect(plain).not.toContain("aria-label");
  });
});
