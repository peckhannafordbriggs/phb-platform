import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  LOCK_TTL_MS,
  acquireDraftLock,
  assertDraftNotLockedByAnother,
  pruneExpiredDraftLocks,
  readDraftLock,
  releaseDraftLock,
} from "@/lib/modules/change-orders/mail/draft-locks";
import { createEmployee, disconnectDb, resetDb, testDb } from "./db";

/**
 * The advisory lock.
 *
 * Advisory, and the tests say so: it coordinates the platform with itself and
 * makes no claim about Outlook, which holds no lock and always wins.
 *
 * The property that matters most is that a lock cannot strand a draft. An
 * abandoned tab must not block the person who needs to send.
 */

const MESSAGE_ID = "AAMkImmutableDraftId==";

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await disconnectDb();
});

describe("taking the lock", () => {
  it("gives it to the first asker", async () => {
    const alice = await createEmployee({ entraOid: "oid-alice" });

    const state = await acquireDraftLock(MESSAGE_ID, alice.id);

    expect(state.heldByYou).toBe(true);
    expect(state.heldBy?.id).toBe(alice.id);
    expect(state.expiresAt).not.toBeNull();
  });

  it("refuses to move a live lock to someone else", async () => {
    const alice = await createEmployee({ entraOid: "oid-alice" });
    const bob = await createEmployee({ entraOid: "oid-bob" });

    await acquireDraftLock(MESSAGE_ID, alice.id);
    const bobsView = await acquireDraftLock(MESSAGE_ID, bob.id);

    expect(bobsView.heldByYou).toBe(false);
    expect(bobsView.heldBy?.id).toBe(alice.id);
  });

  it("is idempotent for the holder, and refreshes the expiry", async () => {
    const alice = await createEmployee({ entraOid: "oid-alice" });

    const first = await acquireDraftLock(MESSAGE_ID, alice.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await acquireDraftLock(MESSAGE_ID, alice.id);

    expect(second.heldByYou).toBe(true);
    expect(new Date(second.expiresAt ?? 0).getTime()).toBeGreaterThan(
      new Date(first.expiresAt ?? 0).getTime(),
    );
    expect(await testDb.draftLock.count()).toBe(1);
  });

  it("stores nothing about the message", async () => {
    const alice = await createEmployee({ entraOid: "oid-alice" });
    await acquireDraftLock(MESSAGE_ID, alice.id);

    const row = await testDb.draftLock.findUniqueOrThrow({
      where: { messageId: MESSAGE_ID },
    });

    // An id, a holder and an expiry. No subject, no recipients, no body -
    // nothing about the mailbox is persisted anywhere in this platform.
    expect(Object.keys(row).sort()).toEqual([
      "acquiredAt",
      "expiresAt",
      "heldById",
      "messageId",
    ]);
  });
});

describe("a lock cannot strand a draft", () => {
  it("lapses, letting the next person take it", async () => {
    const alice = await createEmployee({ entraOid: "oid-alice" });
    const bob = await createEmployee({ entraOid: "oid-bob" });

    await acquireDraftLock(MESSAGE_ID, alice.id);

    // Alice closed her tab. The release never arrived, which is exactly the case
    // expiry exists for.
    await testDb.draftLock.update({
      where: { messageId: MESSAGE_ID },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    const bobsView = await acquireDraftLock(MESSAGE_ID, bob.id);

    expect(bobsView.heldByYou).toBe(true);
    expect(bobsView.heldBy?.id).toBe(bob.id);
  });

  it("reads an expired row as no lock at all", async () => {
    const alice = await createEmployee({ entraOid: "oid-alice" });
    const bob = await createEmployee({ entraOid: "oid-bob" });

    await acquireDraftLock(MESSAGE_ID, alice.id);
    await testDb.draftLock.update({
      where: { messageId: MESSAGE_ID },
      data: { expiresAt: new Date(Date.now() - 1) },
    });

    expect(await readDraftLock(MESSAGE_ID, bob.id)).toEqual({
      heldByYou: false,
      heldBy: null,
      expiresAt: null,
    });
  });

  it("expires in well under two minutes", async () => {
    // A long TTL turns a closed tab into a blocked send.
    expect(LOCK_TTL_MS).toBeLessThanOrEqual(120_000);
  });
});

describe("releasing", () => {
  it("lets the holder release", async () => {
    const alice = await createEmployee({ entraOid: "oid-alice" });

    await acquireDraftLock(MESSAGE_ID, alice.id);
    await releaseDraftLock(MESSAGE_ID, alice.id);

    expect(await testDb.draftLock.count()).toBe(0);
  });

  it("ignores a release from someone who does not hold it", async () => {
    const alice = await createEmployee({ entraOid: "oid-alice" });
    const bob = await createEmployee({ entraOid: "oid-bob" });

    await acquireDraftLock(MESSAGE_ID, alice.id);
    await releaseDraftLock(MESSAGE_ID, bob.id);

    expect((await readDraftLock(MESSAGE_ID, alice.id)).heldByYou).toBe(true);
  });
});

describe("the write guard", () => {
  it("blocks a write while someone else holds the lock", async () => {
    const alice = await createEmployee({ entraOid: "oid-alice" });
    const bob = await createEmployee({ entraOid: "oid-bob" });

    await acquireDraftLock(MESSAGE_ID, alice.id);

    await expect(
      assertDraftNotLockedByAnother(MESSAGE_ID, bob.id),
    ).rejects.toMatchObject({ kind: "locked" });
  });

  it("permits the holder", async () => {
    const alice = await createEmployee({ entraOid: "oid-alice" });
    await acquireDraftLock(MESSAGE_ID, alice.id);

    await expect(
      assertDraftNotLockedByAnother(MESSAGE_ID, alice.id),
    ).resolves.toBeUndefined();
  });

  it("permits anyone when the draft is not locked", async () => {
    const bob = await createEmployee({ entraOid: "oid-bob" });

    // An unlocked draft is writable. The lock is a courtesy between colleagues,
    // not an authorization boundary - requiring one would mean a dropped lock
    // blocked a send that needed to happen.
    await expect(
      assertDraftNotLockedByAnother(MESSAGE_ID, bob.id),
    ).resolves.toBeUndefined();
  });

  it("permits anyone once the lock has lapsed", async () => {
    const alice = await createEmployee({ entraOid: "oid-alice" });
    const bob = await createEmployee({ entraOid: "oid-bob" });

    await acquireDraftLock(MESSAGE_ID, alice.id);
    await testDb.draftLock.update({
      where: { messageId: MESSAGE_ID },
      data: { expiresAt: new Date(Date.now() - 1) },
    });

    await expect(
      assertDraftNotLockedByAnother(MESSAGE_ID, bob.id),
    ).resolves.toBeUndefined();
  });
});

describe("housekeeping", () => {
  it("prunes only expired rows", async () => {
    const alice = await createEmployee({ entraOid: "oid-alice" });

    await acquireDraftLock("live", alice.id);
    await acquireDraftLock("dead", alice.id);
    await testDb.draftLock.update({
      where: { messageId: "dead" },
      data: { expiresAt: new Date(Date.now() - 1) },
    });

    expect(await pruneExpiredDraftLocks()).toBe(1);
    expect(await testDb.draftLock.count()).toBe(1);
  });
});
