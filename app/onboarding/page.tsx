import { redirect } from "next/navigation";
import { requireAuthenticated } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { OnboardingForm } from "./onboarding-form";

export const dynamic = "force-dynamic";

/**
 * Outside the shell on purpose: while profileCompleted is false this is the
 * only reachable route besides sign-out.
 */
export default async function OnboardingPage() {
  const access = await requireAuthenticated();

  if (!access.ok) {
    if (access.denial === "employee_inactive") redirect("/unauthorized");
    redirect("/signin");
  }

  if (access.viewer.profileCompleted) {
    redirect("/");
  }

  const [positions, departments] = await Promise.all([
    prisma.position.findMany({
      where: { status: "active" },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.department.findMany({
      where: { status: "active" },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  return (
    <main className="mx-auto max-w-lg px-6 py-16">
      <h1 className="text-xl font-semibold">Complete your profile</h1>
      <p className="mt-2 text-sm text-[var(--muted)]">
        You are signed in. These details help administrators identify you; they
        do not affect what you can access.
      </p>

      <OnboardingForm
        email={access.viewer.email}
        firstName={access.viewer.firstName}
        lastName={access.viewer.lastName}
        positions={positions}
        departments={departments}
      />
    </main>
  );
}
