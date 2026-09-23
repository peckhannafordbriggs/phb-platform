import { ModuleHeader } from "@/components/module-header";
import { moduleAccentStyle } from "@/lib/module-accent";

/** A granted module with no screens yet. Says so rather than 404ing. */
export function ModulePlaceholder({
  moduleKey,
  title,
}: {
  moduleKey: string;
  title: string;
}) {
  return (
    <div
      className="dashboard-ground -mx-8 -my-8 px-8 py-8"
      style={{ ...moduleAccentStyle(moduleKey), minHeight: "100vh" }}
    >
      <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-3xl flex-col">
        <ModuleHeader moduleKey={moduleKey} title={title} />

        <div className="flex flex-1 items-center justify-center pb-16">
          <div className="card px-8 py-10 text-center">
            <h2 className="font-display text-lg font-semibold">
              Content not available
            </h2>
            <p className="mt-2 max-w-sm text-sm text-[var(--muted)]">
              This module has no screens in this build yet.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
