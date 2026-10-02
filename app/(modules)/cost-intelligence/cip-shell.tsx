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
    // Exactly one screen tall: the header stays put and only the content below it scrolls.
    <div
      className="dashboard-ground -mx-8 -my-8 flex h-dvh flex-col"
      style={moduleAccentStyle(COST_INTELLIGENCE_MODULE_KEY)}
    >
      <div className="relative mx-auto w-full max-w-[88rem] shrink-0 px-8 pt-8">
        <ModuleHeader
          moduleKey={COST_INTELLIGENCE_MODULE_KEY}
          title={COST_INTELLIGENCE_MODULE_NAME}
          blurb="Run published cost workflows against SharePoint project folders."
        >
          <CipNav tabs={tabs} label="Cost Intelligence sections" actions={actions} />
        </ModuleHeader>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-8 pt-6">
        <div className="mx-auto flex min-h-full max-w-[88rem] flex-col">{children}</div>
      </div>
    </div>
  );
}
