import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { writeAuditEvent } from "@/lib/audit";
import {
  evaluateGate,
  type GateDenialReason,
  type GatedIdentity,
  type TokenClaims,
} from "./gate";

export type SignInDenialReason = GateDenialReason | "employee_disabled";

export type SignInOutcome =
  | { ok: true; employeeId: string; entraOid: string }
  | { ok: false; reason: SignInDenialReason };

/**
 * Runs the full four-check login gate and, on success, self-provisions.
 *
 * A rejected sign-in writes login.denied and creates no employee row. That
 * ordering is the point: the table must not accumulate rows for identities the
 * platform refuses.
 */
export async function applyLoginGate(
  claims: TokenClaims,
): Promise<SignInOutcome> {
  const gate = evaluateGate(claims, {
    tenantId: env.AUTH_MICROSOFT_ENTRA_ID_TENANT_ID,
    allowedDomains: env.ALLOWED_EMAIL_DOMAINS,
  });

  if (!gate.ok) {
    await denied(gate.reason, gate.email, null);
    return { ok: false, reason: gate.reason };
  }

  return provision(gate.identity);
}

async function denied(
  reason: SignInDenialReason,
  email: string | null,
  employeeId: string | null,
): Promise<void> {
  await writeAuditEvent(prisma, {
    action: "login.denied",
    // Null unless the identity is already known: a rejected sign-in must not
    // cause a row to exist.
    targetEmployeeId: employeeId,
    metadata: { reason, email },
  });
}

async function provision(identity: GatedIdentity): Promise<SignInOutcome> {
  const now = new Date();

  const existing =
    (await prisma.employee.findUnique({
      where: { entraOid: identity.entraOid },
      select: { id: true, status: true, email: true },
    })) ??
    // A row seeded ahead of its owner's first sign-in - the bootstrap admin -
    // has a matching email and no entraOid yet.
    (await prisma.employee.findFirst({
      where: { email: identity.email, entraOid: null },
      select: { id: true, status: true, email: true },
    }));

  // Check 4 - status. Evaluated before any write, so a disabled employee's
  // sign-in leaves no trace beyond the audit event.
  if (existing !== null && existing.status === "disabled") {
    await denied("employee_disabled", identity.email, existing.id);
    return { ok: false, reason: "employee_disabled" };
  }

  if (existing !== null) {
    await prisma.employee.update({
      where: { id: existing.id },
      data: {
        // Stamped once. Never included in a later update - see the comment on
        // Employee.entraOid in the schema.
        entraOid: identity.entraOid,
        // Entra is authoritative for the address; people get renamed. Names are
        // not overwritten because onboarding lets the employee correct them.
        email: identity.email,
        lastLoginAt: now,
      },
    });
    return { ok: true, employeeId: existing.id, entraOid: identity.entraOid };
  }

  const isBootstrapAdmin =
    env.BOOTSTRAP_ADMIN_EMAIL !== undefined &&
    env.BOOTSTRAP_ADMIN_EMAIL === identity.email;

  const created = await prisma.$transaction(async (tx) => {
    const employee = await tx.employee.create({
      data: {
        entraOid: identity.entraOid,
        email: identity.email,
        firstName: identity.firstName,
        lastName: identity.lastName,
        profileCompleted: false,
        isPlatformAdmin: isBootstrapAdmin,
        firstSeenAt: now,
        lastLoginAt: now,
      },
      select: { id: true },
    });

    // Zero grants. Admins grant access; signing in does not.
    await writeAuditEvent(tx, {
      action: "employee.provisioned",
      targetEmployeeId: employee.id,
      metadata: { email: identity.email, bootstrapAdmin: isBootstrapAdmin },
    });

    return employee;
  });

  return { ok: true, employeeId: created.id, entraOid: identity.entraOid };
}
