import { describe, expect, it } from "vitest";
import {
  ancestorsOf,
  buildFolderTree,
  initiallyExpandedFolderIds,
  sortFolders,
  type FolderNode,
} from "@/app/(modules)/change-orders/mailbox-client";

/**
 * The pure parts of the mailbox UI: how the flat folder list becomes a tree, and
 * how it is ordered.
 *
 * The shape here is the real one, taken from changeorder@phb1899.com - `Projects`
 * is a child of Inbox, so project folders sit at depth 2 and their contents at
 * depth 3. A tree that stops early shows `Projects` as empty, which looks correct
 * and is wrong.
 */

function folder(
  id: string,
  displayName: string,
  parentFolderId: string | null,
  extra: Partial<FolderNode> = {},
): FolderNode {
  return {
    id,
    displayName,
    parentFolderId,
    childFolderCount: 0,
    totalItemCount: 0,
    unreadItemCount: 0,
    wellKnownName: null,
    ...extra,
  };
}

/** The live mailbox, flattened the way the service returns it. */
const REAL_MAILBOX: FolderNode[] = [
  folder("inbox", "Inbox", "root", { wellKnownName: "inbox", childFolderCount: 2, totalItemCount: 7 }),
  folder("drafts", "Drafts", "root", { wellKnownName: "drafts" }),
  folder("sent", "Sent Items", "root", { wellKnownName: "sentitems", totalItemCount: 6 }),
  folder("deleted", "Deleted Items", "root", { wellKnownName: "deleteditems", totalItemCount: 2 }),
  folder("archive", "Archive", "root"),
  folder("junk", "Junk Email", "root"),
  folder("processed", "Processed CO's", "inbox", { totalItemCount: 4 }),
  folder("projects", "Projects", "inbox", { childFolderCount: 3 }),
  folder("liberty", "CCHMC Liberty Expansion", "projects", { childFolderCount: 3 }),
  folder("reeses", "P&G Reese's", "projects", { childFolderCount: 2 }),
  folder("bulletin12", "CCHMC Bulletin 12", "liberty", { totalItemCount: 13 }),
  folder("rfi187", "CCHMC RFI 187", "liberty", { totalItemCount: 2 }),
  folder("rfi229", "CCHMC RFI 229", "liberty", { totalItemCount: 7 }),
];

describe("the folder tree", () => {
  it("nests the real mailbox to depth 3", () => {
    const tree = buildFolderTree(REAL_MAILBOX);

    const inbox = tree.find((n) => n.id === "inbox");
    expect(inbox?.depth).toBe(0);

    const projects = inbox?.children.find((n) => n.id === "projects");
    expect(projects?.depth).toBe(1);

    const liberty = projects?.children.find((n) => n.id === "liberty");
    expect(liberty?.depth).toBe(2);

    const bulletin = liberty?.children.find((n) => n.id === "bulletin12");
    expect(bulletin?.depth).toBe(3);
    expect(bulletin?.totalItemCount).toBe(13);
  });

  it("treats a folder whose parent is absent as a root", () => {
    // The mailbox root itself is never returned, so its children arrive with a
    // parentFolderId nothing in the list matches.
    const tree = buildFolderTree(REAL_MAILBOX);

    expect(tree.map((n) => n.id)).toContain("inbox");
    expect(tree.map((n) => n.id)).toContain("drafts");
    expect(tree.every((n) => n.depth === 0)).toBe(true);
  });

  it("puts the well-known folders first, in working order", () => {
    const roots = buildFolderTree(REAL_MAILBOX).map((n) => n.displayName);

    expect(roots.slice(0, 4)).toEqual([
      "Inbox",
      "Drafts",
      "Sent Items",
      "Deleted Items",
    ]);
    // Everything else alphabetically.
    expect(roots.slice(4)).toEqual(["Archive", "Junk Email"]);
  });

  it("orders ordinary sibling folders alphabetically", () => {
    const projects = buildFolderTree(REAL_MAILBOX)
      .find((n) => n.id === "inbox")
      ?.children.find((n) => n.id === "projects");

    expect(projects?.children.map((n) => n.displayName)).toEqual([
      "CCHMC Liberty Expansion",
      "P&G Reese's",
    ]);
  });

  it("does not lose a folder whose parent appears after it", () => {
    // Graph returns no ordering guarantee, so the child may arrive first.
    const reversed = [...REAL_MAILBOX].reverse();

    const count = (nodes: ReturnType<typeof buildFolderTree>): number =>
      nodes.reduce((sum, n) => sum + 1 + count(n.children), 0);

    expect(count(buildFolderTree(reversed))).toBe(REAL_MAILBOX.length);
  });

  it("survives a folder that claims itself as its own parent", () => {
    // Defensive: a cycle must not become infinite recursion in the browser.
    const cyclic = [folder("a", "A", "a")];

    const tree = buildFolderTree(cyclic);
    expect(tree).toHaveLength(0);
  });
});

describe("revealing the selected folder", () => {
  it("returns every ancestor, so the tree can open to a depth-3 folder", () => {
    expect(ancestorsOf(REAL_MAILBOX, "bulletin12")).toEqual([
      "liberty",
      "projects",
      "inbox",
    ]);
  });

  it("returns nothing for a root", () => {
    expect(ancestorsOf(REAL_MAILBOX, "drafts")).toEqual([]);
  });

  it("returns nothing for a folder it does not know", () => {
    expect(ancestorsOf(REAL_MAILBOX, "nope")).toEqual([]);
  });
});

describe("what the tree shows on first paint", () => {
  /**
   * The regression this exists for: the tree used to paint fully collapsed. The
   * only thing that auto-expanded was the path to the selected folder, and the
   * default selection is Drafts - a root with no ancestors - so nothing expanded
   * at all. That showed 8 of 19 folders with no sign that a project hierarchy
   * existed, which reads as a truncated tree rather than a closed one.
   */
  function visibleRows(expanded: Set<string>): string[] {
    const rows: string[] = [];
    const walk = (nodes: ReturnType<typeof buildFolderTree>): void => {
      for (const node of nodes) {
        rows.push(node.displayName);
        if (expanded.has(node.id)) walk(node.children);
      }
    };
    walk(buildFolderTree(REAL_MAILBOX));
    return rows;
  }

  it("opens the roots that have children, so Projects is visible", () => {
    const expanded = new Set(initiallyExpandedFolderIds(REAL_MAILBOX));
    const rows = visibleRows(expanded);

    // Projects is a child of Inbox. If Inbox is closed, it does not exist as far
    // as the reader is concerned.
    expect(rows).toContain("Projects");
    expect(rows).toContain("Processed CO's");
    expect(expanded.has("inbox")).toBe(true);
  });

  it("leaves deeper levels closed, so Drafts is not buried", () => {
    const rows = visibleRows(new Set(initiallyExpandedFolderIds(REAL_MAILBOX)));

    // Projects' own children stay collapsed - opening everything would put all
    // 19 folders on screen and push the default selection out of view.
    expect(rows).not.toContain("CCHMC Liberty Expansion");
    expect(rows).not.toContain("CCHMC Bulletin 12");

    // The folder the default selection just chose is still near the top.
    expect(rows.indexOf("Drafts")).toBeLessThan(5);
  });

  it("would have shown only the roots before the fix", () => {
    // Documents the old behaviour so the difference is legible.
    expect(visibleRows(new Set())).toHaveLength(6);
    expect(visibleRows(new Set())).not.toContain("Projects");
  });

  it("expands nothing when no root has children", () => {
    const flat = REAL_MAILBOX.filter((f) => f.parentFolderId === "root").map((f) => ({
      ...f,
      childFolderCount: 0,
    }));

    expect(initiallyExpandedFolderIds(flat)).toEqual([]);
  });
});

describe("the default folder", () => {
  it("is Drafts, because reviewing what the automation produced is the job", () => {
    const drafts = sortFolders(REAL_MAILBOX).find(
      (f) => f.wellKnownName === "drafts",
    );

    expect(drafts?.displayName).toBe("Drafts");
    // And it is genuinely empty most of the day, which is the empty state the
    // primary user sees first.
    expect(drafts?.totalItemCount).toBe(0);
  });
});
