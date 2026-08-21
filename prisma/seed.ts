import { createDbClient } from "../scripts/db";
import {
  parseBootstrapAdmins,
  seedBootstrapAdmins,
} from "../lib/bootstrap-admins";

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
  {
    key: "bas",
    displayName: "Building Automation",
    description:
      "Trended data from the building automation system: collection health, point history, and questions in English.",
    icon: "gauge",
    sortOrder: 200,
  },
];

// From docs/05-database-and-sources.md, so early users are not all choosing
// "Other". Admin-editable afterwards, and displayed alphabetically wherever it
// is shown - the order here is insertion order and does not reach a screen.
//
// Additive, like DEPARTMENTS below: this runs on every deploy, and removing
// anything not named here would delete a position an admin had added.
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
  "Co-Op Intern",
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

    const { emails, invalid } = parseBootstrapAdmins(
      process.env.BOOTSTRAP_ADMIN_EMAIL,
    );

    if (invalid.length > 0) {
      throw new Error(
        `BOOTSTRAP_ADMIN_EMAIL contains entries that are not email addresses: ` +
          `${invalid.join(", ")}. It is a comma-separated list.`,
      );
    }

    if (emails.length === 0) {
      console.warn(
        "BOOTSTRAP_ADMIN_EMAIL is not set - no admin was seeded. " +
          "Nobody will be able to reach the admin screen.",
      );
    } else {
      const seeded = await seedBootstrapAdmins(prisma, emails);

      // Reported per outcome rather than as a total, so re-running is visibly a
      // no-op instead of looking like it rewrote four rows.
      if (seeded.created.length > 0) {
        console.log(`Bootstrap admins created: ${seeded.created.join(", ")}`);
      }
      if (seeded.promoted.length > 0) {
        console.warn(
          `No active administrator remained, so the bootstrap list was promoted: ` +
            `${seeded.promoted.join(", ")}`,
        );
      }
      if (seeded.unchanged.length > 0) {
        console.log(`Bootstrap admins already present: ${seeded.unchanged.join(", ")}`);
      }
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
