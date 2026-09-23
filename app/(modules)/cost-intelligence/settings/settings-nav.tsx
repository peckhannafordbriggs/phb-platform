import Link from "next/link";

const LINKS = [
  { href: "/cost-intelligence/settings", label: "Skill catalog" },
  { href: "/cost-intelligence/settings/workflows", label: "Workflows" },
  { href: "/cost-intelligence/settings/access", label: "Access & roles" },
  { href: "/cost-intelligence/settings/usage", label: "Usage & cost" },
];

export function SettingsNav() {
  return (
    <nav className="mb-6 flex gap-4 text-sm">
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} className="underline">
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
