import { ModuleHeader } from "@/components/module-header";
import { moduleAccentStyle } from "@/lib/module-accent";
import {
  COST_INTELLIGENCE_MODULE_KEY,
  COST_INTELLIGENCE_MODULE_NAME,
} from "@/lib/modules/cost-intelligence/constants";
import { CipNav, type Tab } from "./cip-nav";

/** Chrome for every CIP view. A component, not a layout, so it never wraps a 404. */
export function CipShell({
  canAdminister = false,
  actions,
  children,
}: {
  canAdminister?: boolean;
  /** Right-aligned controls on the header row, e.g. search and New run. */
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  const tabs: Tab[] = [
    { href: "/cost-intelligence", label: "Runs", prefixes: ["/cost-intelligence/runs"] },
    ...(canAdminister
      ? [{ href: "/cost-intelligence/settings", label: "Settings", prefixes: ["/cost-intelligence/settings"] }]
      : []),
  ];

  return (
    <div
      className="dashboard-ground -mx-8 -my-8 px-8 py-8"
      style={{ ...moduleAccentStyle(COST_INTELLIGENCE_MODULE_KEY), minHeight: "100vh" }}
    >
      <div className="mx-auto max-w-[88rem]">
        <div className="relative">
          <ModuleHeader
            moduleKey={COST_INTELLIGENCE_MODULE_KEY}
            title={COST_INTELLIGENCE_MODULE_NAME}
            blurb="Run published cost workflows against SharePoint project folders."
          >
            <CipNav tabs={tabs} label="Cost Intelligence sections" actions={actions} />
          </ModuleHeader>
        </div>
        <div className="mt-6">{children}</div>
      </div>
    </div>
  );
}
