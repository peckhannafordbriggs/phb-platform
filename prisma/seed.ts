import { createDbClient } from "../scripts/db";
import {
  parseBootstrapAdmins,
  seedBootstrapAdmins,
} from "../lib/bootstrap-admins";
import { seedBasVocabularies } from "./bas-vocabularies";

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

    // The BAS semantic vocabularies. Reference data like POSITIONS and
    // DEPARTMENTS, and until now the one piece of it that no migration and no
    // seed created - it reached the development database only via
    // scripts/bas-import.ts, so a fresh database came up with an empty
    // vocabulary and nothing said so. See prisma/bas-vocabularies.ts.
    const vocab = await seedBasVocabularies(prisma);

    // Not fatal: a role a point already references cannot be deleted, so an
    // undeclared row is something to look at rather than something to fix here.
    if (vocab.undeclared.length > 0) {
      console.warn(
        `bas_point_roles contains ${vocab.undeclared.length} role(s) this repo ` +
          `does not declare: ${vocab.undeclared.join(", ")}. ` +
          `Add them to prisma/bas-vocabularies.ts or remove them by hand.`,
      );
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
    // Counted rather than assumed. A vocabulary that silently seeded nothing is
    // the failure this line exists to make visible.
    console.log(
      `Seeded ${vocab.pointRoles} BAS point roles ` +
        `(${vocab.setpointLinks} setpoint links, ${vocab.statusLinks} status links) ` +
        `and ${vocab.equipmentTypes} equipment types.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
