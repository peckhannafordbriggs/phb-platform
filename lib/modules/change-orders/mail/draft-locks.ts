import { prisma } from "@/lib/db";
import { MailError } from "./errors";

/**
 * Advisory locks on draft editing.
 *
 * Advisory in the strict sense: this coordinates the platform with itself. The
 * operator has the same mailbox open in Outlook, Outlook holds no lock, and
 * Graph offers no useful concurrency control - docs/03, last write wins. So this
 * prevents two people in the platform colliding, and the UI is honest that
 * Outlook can still overwrite anything.
 *
 * Expiry rather than an explicit unlock is the release mechanism, because a
 * closed tab never sends one. A lock that lapses early is a nuisance; a lock
 * that strands the draft someone needs to send is worse.
 */

/**
 * Short, because the cost of being wrong is asymmetric. The editor refreshes
 * while it is open, so an active editor never loses its lock, and an abandoned
 * one frees the draft in about a minute.
 */
export const LOCK_TTL_MS = 90_000;

export interface LockState {
  heldByYou: boolean;
  heldBy: { id: string; firstName: string; lastName: string } | null;
  expiresAt: string | null;
}

function expiryFromNow(): Date {
  return new Date(Date.now() + LOCK_TTL_MS);
}

/**
 * Takes or refreshes the lock.
 *
 * One statement, so two tabs racing cannot both win: the upsert's WHERE only
 * matches a row that is already ours or already expired. A lock held by someone
 * else and still live makes this a no-op, and the caller is told who has it.
 */
export async function acquireDraftLock(
  messageId: string,
  employeeId: string,
): Promise<LockState> {
  const now = new Date();

  // Not a transaction with a read first: the read-then-write would be the race.
  const taken = await prisma.draftLock.updateMany({
    where: {
      messageId,
      OR: [{ heldById: employeeId }, { expiresAt: { lt: now } }],
    },
    data: { heldById: employeeId, expiresAt: expiryFromNow(), acquiredAt: now },
  });

  if (taken.count === 0) {
    try {
      await prisma.draftLock.create({
        data: { messageId, heldById: employeeId, expiresAt: expiryFromNow() },
      });
    } catch {
      // Someone inserted between the update and the create. Fall through and
      // report whoever actually holds it.
    }
  }

  return readDraftLock(messageId, employeeId);
}

/** Releases the lock, but only if this employee holds it. */
export async function releaseDraftLock(
  messageId: string,
  employeeId: string,
): Promise<void> {
  await prisma.draftLock.deleteMany({ where: { messageId, heldById: employeeId } });
}

export async function readDraftLock(
  messageId: string,
  employeeId: string,
): Promise<LockState> {
  const lock = await prisma.draftLock.findUnique({
    where: { messageId },
    select: {
      heldById: true,
      expiresAt: true,
      heldBy: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  // An expired row is not a lock. It is left to be reused rather than deleted on
  // read, so a read never writes.
  if (lock === null || lock.expiresAt.getTime() <= Date.now()) {
    return { heldByYou: false, heldBy: null, expiresAt: null };
  }

  return {
    heldByYou: lock.heldById === employeeId,
    heldBy: lock.heldBy,
    expiresAt: lock.expiresAt.toISOString(),
  };
}

/**
 * Throws unless this employee may write to the draft.
 *
 * Called before a save or a send. An unlocked draft is writable - the lock is a
 * courtesy between colleagues, not an authorization boundary, and requiring one
 * would mean a dropped lock blocked a send that needed to happen.
 */
export async function assertDraftNotLockedByAnother(
  messageId: string,
  employeeId: string,
): Promise<void> {
  const state = await readDraftLock(messageId, employeeId);

  if (state.heldBy !== null && !state.heldByYou) {
    throw new MailError("locked", {
      detail: `Draft ${messageId} is locked by employee ${state.heldBy.id}.`,
    });
  }
}

/**
 * Removes expired rows. Not required for correctness - every read already treats
 * an expired row as absent - so this is housekeeping, called opportunistically.
 */
export async function pruneExpiredDraftLocks(): Promise<number> {
  const { count } = await prisma.draftLock.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return count;
}
