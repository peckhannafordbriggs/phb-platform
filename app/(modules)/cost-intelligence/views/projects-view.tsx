import { ChevronRight, FileText, Folder } from "lucide-react";
import type { CipProjectSync } from "@/lib/generated/prisma/client";
import type { ProjectFileNode, ProjectListItem, readProjectFiles } from "@/lib/modules/cost-intelligence/project-sync";
import { Card } from "../ui/Card";
import { Pill } from "../ui/Pill";
import { SideList, SyncButton, SyncStatus } from "./side-list";

const MOMENT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "America/New_York",
});
const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });
const SHORT_DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });

/** 1.2 GB, 340 MB, 12 KB. */
export function formatBytes(bytes: number | bigint): string {
  let value = Number(bytes);
  for (const unit of ["B", "KB", "MB", "GB"]) {
    if (value < 1024 || unit === "GB") return `${unit === "B" ? value : value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
    value /= 1024;
  }
  return `${value} GB`;
}

export type ProjectFiles = Awaited<ReturnType<typeof readProjectFiles>>;

/** Projects on the left; the selected one, with its file tree as of the last sync, on the right. */
export function ProjectsView({
  projects,
  selected,
  files,
  lastSync,
}: {
  projects: ProjectListItem[];
  selected: ProjectListItem | null;
  files: ProjectFiles | null;
  lastSync: CipProjectSync | null;
}) {
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[21rem_minmax(0,1fr)] lg:min-h-[22rem] lg:flex-[1_1_0px] lg:grid-rows-[minmax(0,1fr)]">
      <Card padding="p-0" className="flex min-h-0 flex-col">
        <div className="shrink-0 border-b border-[var(--divider-soft)] px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <span className="eyebrow whitespace-nowrap text-[var(--muted)]">Projects · {projects.length}</span>
            <SyncButton url="/api/modules/cost-intelligence/sync/projects" />
          </div>
          <SyncStatus
            sync={
              lastSync && {
                ...lastSync,
                added: lastSync.projectsAdded,
                updated: lastSync.projectsUpdated,
                removed: lastSync.projectsRemoved,
              }
            }
          />
        </div>
        <SideList
          items={projects.map((p) => ({
            id: p.id.toString(),
            href: `/cost-intelligence/settings/projects/${p.id}`,
            label: p.folderName,
            meta: p.lastModified ? SHORT_DAY.format(p.lastModified) : "Empty",
          }))}
          selected={selected?.id.toString() ?? null}
          empty="No projects yet. Press Sync to read the BID-DOC folder."
          filterLabel="Filter projects"
        />
      </Card>
      {selected ? (
        <ProjectDetail project={selected} files={files} />
      ) : (
        <Card className="flex min-h-0 items-center justify-center">
          <p className="text-[0.875rem] text-[var(--muted)]">No projects yet. Press Sync to read the BID-DOC folder.</p>
        </Card>
      )}
    </div>
  );
}

function ProjectDetail({ project, files }: { project: ProjectListItem; files: ProjectFiles | null }) {
  return (
    <Card padding="p-0" className="min-h-0 overflow-y-auto">
      <div className="flex flex-col gap-5 px-6 py-5">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold">{project.folderName}</h2>
          <p className="mt-1 break-all font-mono text-[0.75rem] text-[var(--muted)]">{project.locationPath}</p>
        </div>

        <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-4 gap-y-2 text-[0.8125rem]">
          <dt className="text-[var(--muted)]">Files</dt>
          <dd>
            {project.fileCount.toLocaleString("en-US")} · {formatBytes(project.totalBytes)}
          </dd>
          <dt className="text-[var(--muted)]">Last changed</dt>
          <dd>{project.lastModified ? DAY.format(project.lastModified) : "Empty folder"}</dd>
          <dt className="text-[var(--muted)]">AI FILES</dt>
          <dd>
            {project.aiFileCount === null
              ? "Not created yet. The first run creates it."
              : `${project.aiFileCount} ${project.aiFileCount === 1 ? "file" : "files"}`}
          </dd>
          <dt className="text-[var(--muted)]">Last synced</dt>
          <dd>{MOMENT.format(project.lastSynced)}</dd>
        </dl>

        <div>
          <span className="eyebrow text-[var(--muted)]">Categories</span>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {project.categories.length === 0 ? (
              <span className="text-[0.8125rem] text-[var(--muted)]">None</span>
            ) : (
              project.categories.map((c) => (
                <Pill key={c} tone={/^ai files$/i.test(c) ? "draft" : "muted"}>
                  {c}
                </Pill>
              ))
            )}
          </div>
        </div>

        <div>
          <span className="eyebrow text-[var(--muted)]">Files · as of the last sync</span>
          <div className="mt-2 rounded-[var(--radius-row)] border border-[var(--border)] bg-white px-2 py-2 text-[0.8125rem]">
            <FileTree files={files} />
          </div>
        </div>
      </div>
    </Card>
  );
}

function FileTree({ files }: { files: ProjectFiles | null }) {
  if (files === null) return null;
  if ("error" in files) return <p className="px-2 py-1 text-[var(--muted)]">{files.error}</p>;
  if (files.tree.length === 0) return <p className="px-2 py-1 text-[var(--muted)]">This folder is empty.</p>;
  return (
    <>
      <Nodes nodes={files.tree} />
      {files.truncated && (
        <p className="px-2 pt-2 text-[0.75rem] text-[var(--muted)]">
          Showing the first 5,000 entries. Open the folder to see the rest.
        </p>
      )}
    </>
  );
}

/** Native <details>, so folders open and close with no client code. */
function Nodes({ nodes }: { nodes: ProjectFileNode[] }) {
  return (
    <ul className="flex flex-col">
      {nodes.map((n) =>
        n.type === "dir" ? (
          <li key={n.path}>
            <details className="group">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded px-2 py-1 hover:bg-[var(--neutral-100)]">
                <ChevronRight
                  size={14}
                  aria-hidden="true"
                  className="shrink-0 text-[var(--muted)] transition-transform group-open:rotate-90"
                />
                <Folder size={14} aria-hidden="true" className="shrink-0 text-[var(--muted)]" />
                <span className="truncate font-medium">{n.name}</span>
                <span className="ml-auto shrink-0 text-[0.6875rem] text-[var(--muted)]">{countFiles(n)}</span>
              </summary>
              <div className="ml-4 border-l border-[var(--divider-soft)] pl-1">
                <Nodes nodes={n.children ?? []} />
              </div>
            </details>
          </li>
        ) : (
          <li key={n.path} className="flex items-center gap-1.5 rounded px-2 py-1 pl-[1.625rem]">
            <FileText size={14} aria-hidden="true" className="shrink-0 text-[var(--muted)]" />
            <span className="truncate">{n.name}</span>
            <span className="ml-auto shrink-0 text-[0.6875rem] text-[var(--muted)]">
              {n.size === undefined ? "" : formatBytes(n.size)}
            </span>
          </li>
        ),
      )}
    </ul>
  );
}

function countFiles(node: ProjectFileNode): string {
  let n = 0;
  const pending = [...(node.children ?? [])];
  while (pending.length > 0) {
    const next = pending.pop()!;
    if (next.type === "file") n += 1;
    else pending.push(...(next.children ?? []));
  }
  return n === 1 ? "1 file" : `${n} files`;
}
