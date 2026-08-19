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
    <ul className="py-1">
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
      <div
        className={
          "flex items-center gap-0.5 pr-2 " +
          (selected ? "bg-white shadow-sm" : "hover:bg-white/70")
        }
        style={{ paddingLeft: `${node.depth * 12 + 4}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            aria-label={expanded ? `Collapse ${node.displayName}` : `Expand ${node.displayName}`}
            aria-expanded={expanded}
            onClick={() => onToggle(node.id)}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[0.6rem] text-[var(--muted)] hover:bg-[var(--border)]"
          >
            {expanded ? "▾" : "▸"}
          </button>
        ) : (
          <span className="h-5 w-5 shrink-0" />
        )}

        <button
          type="button"
          onClick={() => onSelect(node)}
          aria-current={selected ? "true" : undefined}
          title={node.displayName}
          className={
            "min-w-0 flex-1 truncate py-1.5 text-left text-sm " +
            (selected ? "font-medium text-[var(--accent)]" : "text-[var(--foreground)]")
          }
        >
          {node.displayName}
        </button>

        {node.unreadItemCount > 0 && (
          <span className="shrink-0 rounded-full bg-[var(--accent)] px-1.5 py-0.5 text-[0.625rem] font-medium text-white">
            {node.unreadItemCount}
          </span>
        )}
      </div>

      {hasChildren && expanded && (
        <ul>
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
