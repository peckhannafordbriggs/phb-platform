/**
 * The module's tabs, in one list - the BAS pattern (app/(modules)/bas/tabs.ts),
 * for the same reasons: two tabs do not justify a framework, and adding the
 * second cost a line here plus a page.
 *
 * The sidebar shows ONE "Change Orders" entry regardless. Tabs are navigation
 * within the module, not modules, and every page behind a tab carries its own
 * grant check.
 *
 * The Needs Review tab's label carries a count, which is not in this list: the
 * count is live, fetched by the tab bar, and the list is static.
 */
export interface CoTab {
  /** A real route. Bookmarkable, refreshable, middle-clickable. */
  href: string;
  label: string;
  /** One line under the heading, so a tab says what it is for before it loads. */
  blurb: string;
}

export const MAILBOX_TAB_HREF = "/change-orders";
export const REVIEW_TAB_HREF = "/change-orders/review";

export const CO_TABS: readonly CoTab[] = [
  {
    href: MAILBOX_TAB_HREF,
    label: "Mailbox",
    blurb:
      "Reading changeorder@phb1899.com live. Outlook remains a fully working path and is unaffected by anything here.",
  },
  {
    href: REVIEW_TAB_HREF,
    label: "Needs Review",
    // What the screen cannot say about itself: where the notes come from and
    // that nothing here changes them. A person who moves a note to _archive
    // in SharePoint is still the way an item is resolved.
    blurb:
      "Emails the automation declined to file on its own, with its note on why and what should happen next. Read from the _needs_review folder in SharePoint; nothing here moves or changes anything.",
  },
];

/** The tab with this href, or a loud failure - the argument is always a literal. */
export function coTab(href: string): CoTab {
  const tab = CO_TABS.find((candidate) => candidate.href === href);
  if (tab === undefined) throw new Error(`No Change Orders tab registered for ${href}`);
  return tab;
}

/**
 * Which tab a path belongs to: the longest `href` that is a prefix of it.
 * Every path starts with `/change-orders`, so a naive prefix match would
 * light up Mailbox on the review tab.
 */
export function activeTabHref(pathname: string): string | null {
  let best: string | null = null;

  for (const tab of CO_TABS) {
    const matches = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
    if (matches && (best === null || tab.href.length > best.length)) {
      best = tab.href;
    }
  }

  return best;
}
