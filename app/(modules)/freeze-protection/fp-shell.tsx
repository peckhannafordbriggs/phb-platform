import { ModuleHeader } from "@/components/module-header";
import { moduleAccentStyle } from "@/lib/module-accent";
import {
  FREEZE_PROTECTION_MODULE_KEY,
  FREEZE_PROTECTION_MODULE_NAME,
} from "@/lib/modules/freeze-protection/constants";
import { FpNav } from "./fp-nav";
import { tabs } from "./tabs";

/** Chrome for every Freeze Protection view. A component, not a layout, so it never wraps a 404. */
export function FpShell({
  projectId,
  actions,
  children,
}: {
  /** Carried across tabs so Register and Report open on the same project. */
  projectId?: string;
  /** Right-aligned controls on the tab row. */
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    // One screen tall: the header stays put and only the content scrolls (the CIP shape).
    // No focus outline inside the module, matching Cost Intelligence, by decision (2026-10-21).
    <div
      className="dashboard-ground -mx-8 -my-8 flex h-dvh flex-col [&_:focus-visible]:outline-none!"
      style={moduleAccentStyle(FREEZE_PROTECTION_MODULE_KEY)}
    >
      <div className="relative mx-auto w-full max-w-[88rem] shrink-0 px-8 pt-8">
        <ModuleHeader
          moduleKey={FREEZE_PROTECTION_MODULE_KEY}
          title={FREEZE_PROTECTION_MODULE_NAME}
          blurb="Coil freeze exposure, safeties and test results, by project."
        >
          <FpNav tabs={tabs(projectId)} actions={actions} />
        </ModuleHeader>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-8 pt-6">
        <div className="mx-auto flex min-h-full max-w-[88rem] flex-col">{children}</div>
      </div>
    </div>
  );
}
