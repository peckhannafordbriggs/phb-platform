import Link from "next/link";
import { ModuleHeader } from "@/components/module-header";
import {
  COST_INTELLIGENCE_MODULE_KEY,
  COST_INTELLIGENCE_MODULE_NAME,
} from "@/lib/modules/cost-intelligence/constants";

/** Chrome for every CIP view. A component, not a layout, so it never wraps a 404. */
export function CipShell({
  canAdminister = false,
  children,
}: {
  canAdminister?: boolean;
  children: React.ReactNode;
}) {
  const links = [
    { href: "/cost-intelligence", label: "Runs" },
    { href: "/cost-intelligence/jobs", label: "Jobs" },
    ...(canAdminister ? [{ href: "/cost-intelligence/settings", label: "Settings" }] : []),
  ];

  return (
    <div>
      <ModuleHeader moduleKey={COST_INTELLIGENCE_MODULE_KEY} title={COST_INTELLIGENCE_MODULE_NAME}>
        <nav className="mt-3 flex gap-4 text-sm">
          {links.map((l) => (
            <Link key={l.href} href={l.href} className="underline">
              {l.label}
            </Link>
          ))}
        </nav>
      </ModuleHeader>
      <div className="mt-6">{children}</div>
    </div>
  );
}
