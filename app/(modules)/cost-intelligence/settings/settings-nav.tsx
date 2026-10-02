import { CipNav, type Tab } from "../cip-nav";

const TABS: Tab[] = [
  { href: "/cost-intelligence/settings", label: "Skill catalog", prefixes: ["/cost-intelligence/settings/skills"] },
  { href: "/cost-intelligence/settings/workflows", label: "Workflows" },
  { href: "/cost-intelligence/settings/access", label: "Access & roles" },
  { href: "/cost-intelligence/settings/usage", label: "Usage & cost" },
];

export function SettingsNav() {
  return (
    <div className="-mt-3 mb-6 shrink-0">
      <CipNav
        tabs={TABS}
        label="Cost Intelligence settings"
      />
    </div>
  );
}
