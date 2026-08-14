export const dynamic = "force-dynamic";

/**
 * Home is deliberately undecided - docs/01-vision-and-modules.md says keep it a
 * placeholder until there are real requirements. Do not invent a dashboard.
 */
export default function HomePage() {
  return (
    <div className="max-w-2xl">
      <h1 className="text-xl font-semibold">Home</h1>
      <p className="mt-3 text-sm text-[var(--muted)]">
        Systems you have been granted access to appear in the sidebar. If it is
        empty, an administrator has not granted you access to anything yet.
      </p>
    </div>
  );
}
