import type { Tab } from "./fp-nav";

export const BASE = "/freeze-protection";

/** The project travels in `?project=` so a tab switch keeps it and a refresh restores it. */
export function withProject(path: string, projectId?: string) {
  return projectId ? `${path}?project=${encodeURIComponent(projectId)}` : path;
}

export function tabs(projectId?: string): Tab[] {
  return [
    { href: BASE, label: "Overview", path: BASE, exact: true },
    { href: withProject(`${BASE}/register`, projectId), label: "Register", path: `${BASE}/register` },
    { href: withProject(`${BASE}/report`, projectId), label: "Report", path: `${BASE}/report` },
  ];
}
