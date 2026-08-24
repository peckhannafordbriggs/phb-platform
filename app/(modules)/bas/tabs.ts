/**
 * The module's tabs, in one list.
 *
 * Adding B5's "Ask" is a line here plus `app/(modules)/bas/ask/page.tsx`. That is
 * the whole extension point - there is deliberately no tab framework, no
 * registry and no config file, because two tabs do not justify one and the cost
 * of adding the third is already a single line.
 *
 * The sidebar shows ONE "Building Automation" entry regardless. Tabs are
 * navigation within a module, not modules; `components/sidebar.tsx` renders from
 * the `modules` table and knows nothing about this file.
 */
export interface BasTab {
  /** A real route. Bookmarkable, refreshable, middle-clickable. */
  href: string;
  label: string;
  /** One line under the heading, so a tab says what it is for before it loads. */
  blurb: string;
}

export const BAS_TABS: readonly BasTab[] = [
  {
    href: "/bas",
    label: "Collection Health",
    blurb:
      "Is data arriving, and is any of it about to be lost. The controller keeps " +
      "roughly two days and then overwrites, so this is the screen that has to " +
      "notice before that happens.",
  },
  {
    href: "/bas/points",
    label: "Point Explorer",
    blurb:
      "What one point has been doing over a window - the trend, the summary, and " +
      "the periods we were not collecting.",
  },
];

/**
 * The tab with this href, or a loud failure.
 *
 * Pages use it to render their own blurb, so a page and its tab cannot describe
 * themselves differently. Throwing rather than returning undefined because the
 * argument is always a literal from this file - a miss is a typo, and a typo
 * should not degrade into a blank heading.
 */
export function basTab(href: string): BasTab {
  const tab = BAS_TABS.find((candidate) => candidate.href === href);
  if (tab === undefined) throw new Error(`No BAS tab registered for ${href}`);
  return tab;
}

/**
 * Which tab a path belongs to: the longest `href` that is a prefix of it.
 *
 * Longest-first rather than `startsWith` in list order, because every BAS path
 * starts with `/bas` - a naive prefix match would light up Collection Health on
 * every tab. The boundary check stops `/bas/pointsomething` from matching
 * `/bas/points`.
 */
export function activeTabHref(pathname: string): string | null {
  let best: string | null = null;

  for (const tab of BAS_TABS) {
    const matches =
      pathname === tab.href || pathname.startsWith(`${tab.href}/`);
    if (matches && (best === null || tab.href.length > best.length)) {
      best = tab.href;
    }
  }

  return best;
}

/**
 * A tab's href with the current query string carried across.
 *
 * This is what makes the building filter and the time range survive a tab
 * switch. Selecting a building on one tab and having it reset on the next makes
 * the filter untrustworthy, and an untrustworthy filter is worse than none: a
 * filtered zero and a real zero look identical.
 *
 * Every parameter travels, not just the two shared ones. A tab that does not
 * understand `point` ignores it, and carrying it means switching away and back
 * returns you to the point you were looking at rather than to the first in the
 * list.
 */
export function tabHref(
  href: string,
  params: URLSearchParams | ReadonlyURLSearchParamsLike,
): string {
  const query = params.toString();
  return query.length > 0 ? `${href}?${query}` : href;
}

/** Structural type so this file does not depend on next/navigation. */
export interface ReadonlyURLSearchParamsLike {
  toString(): string;
}
