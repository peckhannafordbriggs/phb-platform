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
 */

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

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
