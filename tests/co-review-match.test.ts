import { describe, expect, it } from "vitest";
import { chooseMatch, searchWindow } from "@/lib/modules/change-orders/review/match";
import type { MessageMatchCandidate } from "@/lib/modules/change-orders/mail/types";

/**
 * Tying a note to its mailbox message, as pure functions.
 *
 * The timings and the Message-ID prefixes below are the live mailbox's on
 * 2026-10-21 (senders replaced): fourteen notes, every one found. The rule
 * they settled is "latest received at or before the note's stamp", because
 * the first draft of this file said "nearest" and a pair of replies 72
 * seconds apart proved it wrong - the stamp is always AFTER the message.
 */

function message(id: string, receivedDateTime: string | null, internetMessageId: string | null = null): MessageMatchCandidate {
  return {
    id,
    conversationId: null,
    subject: "RE: ZZTEST",
    from: null,
    to: [],
    receivedDateTime,
    isDraft: false,
    isRead: true,
    hasAttachments: false,
    internetMessageId,
  };
}

describe("the search window", () => {
  it("is the calendar day with twelve hours of slack either side", () => {
    const window = searchWindow("2026-10-05");
    expect(window?.from.toISOString()).toBe("2026-10-04T12:00:00.000Z");
    expect(window?.to.toISOString()).toBe("2026-10-06T12:00:00.000Z");
  });

  it("refuses anything that is not a date", () => {
    expect(searchWindow("yesterday")).toBeNull();
    expect(searchWindow("2026-13-45")).toBeNull();
    expect(searchWindow("")).toBeNull();
  });
});

/** The 18 August thread: five replies from three people, five notes. */
const DAY = [
  message("a", "2026-08-18T13:02:20Z", "<LV9PR19MB9135AAAA@LV9PR19MB9135.namprd19.prod.outlook.com>"),
  message("b", "2026-08-18T13:34:02Z", "<LV2PR19MB5791BBBB@LV2PR19MB5791.namprd19.prod.outlook.com>"),
  message("c", "2026-08-18T13:35:14Z", "<PH8PR19MB9973CCCC@PH8PR19MB9973.namprd19.prod.outlook.com>"),
  message("d", "2026-08-18T13:37:46Z", "<LV2PR19MB5791DDDD@LV2PR19MB5791.namprd19.prod.outlook.com>"),
  message("e", "2026-08-18T18:05:32Z", "<LV2PR19MB5791EEEE@LV2PR19MB5791.namprd19.prod.outlook.com>"),
];

describe("choosing among candidates", () => {
  it("takes the latest message received at or before the note's stamp - the stamp lands 45 to 70 seconds after the message", () => {
    expect(chooseMatch(DAY, "2026-08-18", "13:03:31", null)?.message.id).toBe("a");
    expect(chooseMatch(DAY, "2026-08-18", "13:34:57", null)?.message.id).toBe("b");
    expect(chooseMatch(DAY, "2026-08-18", "13:36:13", null)?.message.id).toBe("c");
    expect(chooseMatch(DAY, "2026-08-18", "13:38:32", null)?.message.id).toBe("d");
    expect(chooseMatch(DAY, "2026-08-18", "18:06:04", null)?.message.id).toBe("e");
  });

  /**
   * THE PAIR THAT PROVED "NEAREST" WRONG. The note at 13:34:57 is 55 seconds
   * after b and 17 seconds before c; nearest picks c, and c is somebody
   * else's reply. The automation never stamps before the message exists.
   */
  it("does not take the nearest when the nearest is after the stamp", () => {
    expect(chooseMatch(DAY, "2026-08-18", "13:34:57", null)?.message.id).toBe("b");
    expect(chooseMatch(DAY, "2026-08-18", "13:34:57", null)?.message.id).not.toBe("c");
  });

  it("narrows by the Message-ID fragment from the note's name, and says so", () => {
    // [PH8PR19M] is the one reply from the third sender; with it, even a
    // stamp far from the message lands on the right one.
    const choice = chooseMatch(DAY, "2026-08-18", "13:38:32", "PH8PR19M");
    expect(choice?.message.id).toBe("c");
    expect(choice?.matchedBy).toBe("message_id_and_time");

    // [LV2PR19M] names one sender's three replies; the stamp picks among them.
    expect(chooseMatch(DAY, "2026-08-18", "13:38:32", "LV2PR19M")?.message.id).toBe("d");
    expect(chooseMatch(DAY, "2026-08-18", "13:34:57", "LV2PR19M")?.message.id).toBe("b");
  });

  it("falls back to subject and time when no Message-ID matches the fragment", () => {
    const choice = chooseMatch(DAY, "2026-08-18", "13:34:57", "ZZZZZZZZ");
    expect(choice?.message.id).toBe("b");
    expect(choice?.matchedBy).toBe("subject_and_time");
  });

  it("takes the earliest message after the stamp when none is before it - a clock ahead of Exchange", () => {
    expect(chooseMatch(DAY, "2026-08-18", "13:01:00", null)?.message.id).toBe("a");
    expect(chooseMatch(DAY, "2026-08-18", "13:34:30", "PH8PR19M")?.message.id).toBe("c");
  });

  it("takes the newest when the filename carried no time", () => {
    expect(chooseMatch(DAY, "2026-08-18", null, null)?.message.id).toBe("e");
    expect(chooseMatch(DAY, "2026-08-18", null, "LV9PR19M")?.message.id).toBe("a");
  });

  it("returns null for no candidates, and never a guess", () => {
    expect(chooseMatch([], "2026-08-18", "13:00:00", null)).toBeNull();
  });

  it("never prefers a message whose time cannot be read", () => {
    const withBroken = [...DAY, message("broken", null), message("garbage", "not a date")];
    expect(chooseMatch(withBroken, "2026-08-18", "13:03:31", null)?.message.id).toBe("a");
    expect(chooseMatch(withBroken, "2026-08-18", null, null)?.message.id).toBe("e");
    expect(chooseMatch([message("broken", null)], "2026-08-18", "13:03:31", null)?.message.id).toBe("broken");
  });
});
