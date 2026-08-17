import { createDbClient } from "../scripts/db";

/**
 * Production seed. Idempotent - safe to re-run on every deploy.
 *
 * Contains no fake data. Demo employees live in prisma/seed-dev.ts, which
 * refuses to run in production.
 */

const MODULES = [
  {
    key: "change-orders",
    displayName: "Change Orders",
    description:
      "Review and send change-order correspondence for changeorder@phb1899.com.",
    icon: "mail",
    sortOrder: 100,
  },
];

// A first pass at the real list, from docs/05-database-and-sources.md, so early
// users are not all choosing "Other". Admin-editable afterwards.
const POSITIONS = [
  "Foreman",
  "Superintendent",
  "Project Manager",
  "Estimator",
  "Controls Engineer",
  "Project Engineer",
  "Accounting",
  "Administrative",
  "Executive",
];

// The confirmed list, alphabetical. A fresh database gets exactly these.
//
// Admin-editable afterwards, which is why this loop only inserts: it runs on
// every deploy, and removing anything not named here would delete a department
// an admin had added. The one-off removal of the previous placeholder list is a
// migration - 20260817000000_replace_departments - not this file's job.
const DEPARTMENTS = [
  "Administrative",
  "AI",
  "Controls",
  "Engineer",
  "Estimator",
  "Foreman",
  "Piping",
  "Project Manager",
  "Service",
  "Sheet Metal",
  "VDC",
];

async function main(): Promise<void> {
  const prisma = createDbClient();

  try {
    for (const moduleRow of MODULES) {
      await prisma.module.upsert({
        where: { key: moduleRow.key },
        // Status is not updated here: an admin who hid a module should not have
        // it un-hidden by the next deploy.
        update: {
          displayName: moduleRow.displayName,
          description: moduleRow.description,
          icon: moduleRow.icon,
          sortOrder: moduleRow.sortOrder,
        },
        create: moduleRow,
      });
    }

    for (const name of POSITIONS) {
      await prisma.position.upsert({
        where: { name },
        update: {},
        create: { name },
      });
    }

    for (const name of DEPARTMENTS) {
      await prisma.department.upsert({
        where: { name },
        update: {},
        create: { name },
      });
    }

    const bootstrapEmail = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();

    if (bootstrapEmail === undefined || bootstrapEmail.length === 0) {
      console.warn(
        "BOOTSTRAP_ADMIN_EMAIL is not set - no admin was seeded. " +
          "Nobody will be able to reach the admin screen.",
      );
    } else {
      // entraOid stays null: it is stamped on this person's first sign-in.
      // profileCompleted stays false: they complete onboarding like anyone else.
      await prisma.employee.upsert({
        where: { email: bootstrapEmail },
        update: { isPlatformAdmin: true },
        create: {
          email: bootstrapEmail,
          firstName: "Platform",
          lastName: "Administrator",
          isPlatformAdmin: true,
          profileCompleted: false,
        },
      });
      console.log(`Bootstrap admin ready: ${bootstrapEmail}`);
    }

    console.log(
      `Seeded ${MODULES.length} module(s), ${POSITIONS.length} positions, ${DEPARTMENTS.length} departments.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
