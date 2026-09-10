"use client";

import type { FolderTreeNode } from "./mailbox-client";

/**
 * The mail folder pane.
 *
 * Rendered from whatever depth the service returns rather than a fixed two
 * levels: the real mailbox has `Projects` as a child of Inbox, so project
 * folders sit at depth 2 and their contents at depth 3. A tree that stops early
 * shows `Projects` as empty, which looks correct and is wrong.
 */
export function FolderTree({
  nodes,
  selectedId,
  expandedIds,
  onSelect,
  onToggle,
}: {
  nodes: FolderTreeNode[];
  selectedId: string | null;
  expandedIds: Set<string>;
  onSelect: (folder: FolderTreeNode) => void;
  onToggle: (folderId: string) => void;
}) {
  return (
    <ul className="space-y-0.5 p-2">
      {nodes.map((node) => (
        <FolderRow
          key={node.id}
          node={node}
          selectedId={selectedId}
          expandedIds={expandedIds}
          onSelect={onSelect}
          onToggle={onToggle}
        />
      ))}
    </ul>
  );
}

function FolderRow({
  node,
  selectedId,
  expandedIds,
  onSelect,
  onToggle,
}: {
  node: FolderTreeNode;
  selectedId: string | null;
  expandedIds: Set<string>;
  onSelect: (folder: FolderTreeNode) => void;
  onToggle: (folderId: string) => void;
}) {
  const hasChildren = node.children.length > 0;
  const expanded = expandedIds.has(node.id);
  const selected = node.id === selectedId;

  return (
    <li>
      {/*
        A row reads as a rounded card rather than a strip: its own radius, and
        on selection its own surface and a soft lift. Indentation is padding on
        the card, not a margin outside it, so nested rows stay the same width
        and the column keeps one left edge instead of a ragged staircase.
      */}
      <div
        className={
          "flex items-center gap-1 rounded-[var(--radius-row)] pr-2 transition-colors " +
          (selected
            ? "bg-white shadow-[var(--shadow-row)]"
            : "hover:bg-white/70")
        }
        style={{ paddingLeft: `${node.depth * 12 + 6}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            aria-label={expanded ? `Collapse ${node.displayName}` : `Expand ${node.displayName}`}
            aria-expanded={expanded}
            onClick={() => onToggle(node.id)}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[0.6rem] text-[var(--muted)] transition-colors hover:bg-[var(--neutral-100)]"
          >
            {expanded ? "▾" : "▸"}
          </button>
        ) : (
          <span className="h-6 w-6 shrink-0" />
        )}

        <button
          type="button"
          onClick={() => onSelect(node)}
          aria-current={selected ? "true" : undefined}
          title={node.displayName}
          className={
            "min-w-0 flex-1 truncate rounded-[var(--radius-row)] py-2 text-left text-sm " +
            (selected ? "font-medium text-[var(--accent)]" : "text-[var(--foreground)]")
          }
        >
          {node.displayName}
        </button>

        {node.unreadItemCount > 0 && (
          <span className="shrink-0 rounded-full bg-[var(--accent)] px-2 py-0.5 text-[0.625rem] font-medium text-white">
            {node.unreadItemCount}
          </span>
        )}
      </div>

      {hasChildren && expanded && (
        <ul className="mt-0.5 space-y-0.5">
          {node.children.map((child) => (
            <FolderRow
              key={child.id}
              node={child}
              selectedId={selectedId}
              expandedIds={expandedIds}
              onSelect={onSelect}
              onToggle={onToggle}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
