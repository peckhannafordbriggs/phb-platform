import { AppShell } from "@/components/app-shell";

export default function ModulesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AppShell>{children}</AppShell>;
}
