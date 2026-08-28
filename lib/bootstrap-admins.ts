import { z } from "zod";
import type { Prisma, PrismaClient } from "@/lib/generated/prisma/client";
import { writeAuditEvent } from "@/lib/audit";

/**
 * The bootstrap admin list, and the seeding it drives.
 *
 * Deliberately free of import-time side effects, and it never reads process.env
 * itself. lib/env.ts parses the variable as part of the boot schema; prisma/seed.ts
 * cannot import lib/env.ts at all, because seeding a database must not require an
 * Entra app registration to exist - see scripts/db.ts. Both call in here instead,
 * so there is one definition of what the list means.
 */

export interface ParsedBootstrapAdmins {
  /** Lowercased, de-duplicated, in the order given. */
  emails: string[];
  /** Entries that are not email addresses, kept so a caller can report them. */
  invalid: string[];
}

const emailSchema = z.email();

/**
 * Comma-separated, exactly like ALLOWED_EMAIL_DOMAINS. Absent or empty is a valid
 * answer meaning "seed no admins" - the seed warns rather than failing, because a
 * database with no bootstrap admin is recoverable and a deploy that dies on boot
 * is worse.
 */
export function parseBootstrapAdmins(
  raw: string | undefined | null,
): ParsedBootstrapAdmins {
  if (raw === undefined || raw === null || raw.trim().length === 0) {
    return { emails: [], invalid: [] };
  }

  const emails: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  for (const entry of raw.split(",")) {
    const candidate = entry.trim().toLowerCase();
    if (candidate.length === 0) continue;

    if (!emailSchema.safeParse(candidate).success) {
      invalid.push(candidate);
      continue;
    }

    // The same address listed twice must not produce two upserts or two log
    // lines; it is the same person either way.
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    emails.push(candidate);
  }

  return { emails, invalid };
}

export interface BootstrapSeedResult {
  created: string[];
  /** Existing rows promoted because the platform had no active admin left. */
  promoted: string[];
  /** Existing rows left exactly as they were. */
  unchanged: string[];
}

type DbClient = PrismaClient | Prisma.TransactionClient;

/**
 * Seeds the bootstrap admins. Idempotent, and safe to run on every deploy.
 *
 * Three rules, and the second is the subtle one:
 *
 *  1. A missing row is created: entraOid null, profileCompleted false,
 *     isPlatformAdmin true. Their first sign-in stamps the entraOid onto this row
 *     rather than creating a second one - see lib/auth/signin.ts.
 *
 *  2. An existing row is NOT re-promoted. If an admin was demoted through the UI,
 *     that was a decision, and a deploy must not quietly undo it. This is why the
 *     upsert cannot simply set isPlatformAdmin on update.
 *
 *  3. The exception is a total lockout - zero active admins anywhere. That is the
 *     situation this list exists for, and it is what runbook.md tells the
 *     next operator to fix by re-running the seed. Only then are existing rows
 *     promoted, and only the admin flag is touched: a disabled account stays
 *     disabled, because re-enabling one is a decision for a person, not a deploy.
 *
 * Nothing here ever resets a name, an email, a status, or a completed profile.
 */
export async function seedBootstrapAdmins(
  client: DbClient,
  emails: string[],
): Promise<BootstrapSeedResult> {
  const result: BootstrapSeedResult = {
    created: [],
    promoted: [],
    unchanged: [],
  };

  if (emails.length === 0) return result;

  // Read once, before the loop. Creating the first admin inside the loop must not
  // change the answer for the emails after it.
  const lockedOut =
    (await client.employee.count({
      where: { isPlatformAdmin: true, status: "active" },
    })) === 0;

  for (const email of emails) {
    const existing = await client.employee.findUnique({
      where: { email },
      select: { id: true, isPlatformAdmin: true },
    });

    if (existing === null) {
      const created = await client.employee.create({
        data: {
          email,
          // Placeholders. The employee corrects them during onboarding, which is
          // why profileCompleted stays false.
          firstName: "Platform",
          lastName: "Administrator",
          // Stamped on their first sign-in, not now.
          entraOid: null,
          isPlatformAdmin: true,
          profileCompleted: false,
        },
        select: { id: true },
      });

      // A null actor is the honest record: the platform seeded this, not a person.
      await writeAuditEvent(client, {
        action: "employee.provisioned",
        targetEmployeeId: created.id,
        metadata: { email, bootstrapAdmin: true, source: "seed" },
      });
      await writeAuditEvent(client, {
        action: "employee.admin_granted",
        targetEmployeeId: created.id,
        metadata: { reason: "bootstrap admin list", source: "seed" },
      });

      result.created.push(email);
      continue;
    }

    if (existing.isPlatformAdmin) {
      result.unchanged.push(email);
      continue;
    }

    if (!lockedOut) {
      // Demoted on purpose at some point. Leave it.
      result.unchanged.push(email);
      continue;
    }

    await client.employee.update({
      where: { id: existing.id },
      data: { isPlatformAdmin: true },
    });
    await writeAuditEvent(client, {
      action: "employee.admin_granted",
      targetEmployeeId: existing.id,
      metadata: {
        reason: "bootstrap admin list - no active administrator remained",
        source: "seed",
      },
    });

    result.promoted.push(email);
  }

  return result;
}
