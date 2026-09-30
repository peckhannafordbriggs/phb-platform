import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import type { Viewer } from "@/lib/authz";
import { buildMe, type MeModule } from "@/lib/me";
import { describeLastHere } from "@/lib/activity/rollover";
import { CHANGE_ORDERS_MODULE_KEY } from "@/lib/modules/change-orders/constants";
import {
  mailService,
  mailboxConnectionStatus,
} from "@/lib/modules/change-orders/mail/service";
import { BAS_MODULE_KEY } from "@/lib/modules/bas/constants";
import { basDataAvailability } from "@/lib/modules/bas/route-helpers";
import { getCollectionHealth } from "@/lib/modules/bas/service";
import { basFigure } from "./bas-figure";

/**
 * Everything Home shows, gathered in one place.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: every figure on Home is real, is about
 * the person signed in, and degrades to a stated absence rather than to a
 * plausible zero. Home reads two live systems - Exchange through Graph, and the
 * BAS tables - and either can be down while the other is fine. So each card
 * resolves independently and carries its own outcome, and one unreachable
 * system never costs the page.
 *
 * There is no invented metric here, no activity feed and no widget that exists
 * to fill a column. If a number cannot be obtained it says so and still offers
 * the way in, because the way in is the point of the card.
 */

/** A live figure, or an honest account of why there isn't one. */
export type Figure =
  | {
      state: "ok";
      value: string;
      status: string;
      /**
       * The value is a fault that needs acting on - "3 points at risk" - and
       * the card marks it red. Set by the module's own figure builder from
       * the same predicate its screen uses, never from the count alone. A
       * card may never look calmer than the screen behind it.
       */
      alarm?: true;
    }
  /** The module is reachable and has nothing to report. Still a real answer. */
  | { state: "none"; value: string; status: string }
  /** Reached for and failed. Never rendered as zero. */
  | { state: "unavailable"; status: string };

export interface HomeModuleCard {
  key: string;
  displayName: string;
  href: string;
  /** The label on the way in. Always present, including when the figure is not. */
  action: string;
  figure: Figure;
}

/**
 * The previous active day, and the words for it.
 *
 * ONE phrase, computed once and rendered twice - under the greeting and as the
 * digest heading - so the two cannot name different windows.
 */
export interface LastHere {
  at: Date;
  /** "yesterday at 4:52 PM" / "on Monday 14 September at 12:58 PM". */
  phrase: string;
}

export interface HomeGreeting {
  firstName: string;
  positionName: string | null;
  departmentName: string | null;
  /**
   * From `previousActiveAt` - the frozen anchor - and NEVER from
   * `lastActiveAt`, the live value, which the request rendering this page has
   * just moved. Reading the live value would date the digest from a few
   * seconds ago, and the page would look completely normal while telling you
   * nothing.
   *
   * Not from the login columns either. A session lasts days, so
   * `previousLoginAt` says "Monday" all week for somebody who is here every
   * day. See lib/activity/rollover.ts.
   *
   * Null when no previous active day is recorded - a first visit, or a row
   * from before the columns existed. Home then says nothing about a previous
   * visit: no blank, no epoch date.
   */
  lastHere: LastHere | null;
}


/** One line in "since you were last here". Never a count with no subject. */
export interface SinceItem {
  key: string;
  text: string;
  href: string | null;
}

export interface HomeData {
  greeting: HomeGreeting;
  modules: HomeModuleCard[];
  /**
   * Null when there is no previous active day to measure from. That is
   * different from an empty list, which means "you were here before and
   * nothing happened", and the two must not render the same.
   */
  since: SinceItem[] | null;
}

export async function getHomeData(
  viewer: Viewer,
  now: Date = new Date(),
): Promise<HomeData> {
  const [me, employee] = await Promise.all([
    buildMe(viewer),
    prisma.employee.findUnique({
      where: { id: viewer.id },
      select: {
        firstName: true,
        positionOther: true,
        // The frozen anchor. `lastActiveAt` is deliberately NOT selected, so
        // nothing in this file can date a window from the live value.
        previousActiveAt: true,
        position: { select: { name: true } },
        department: { select: { name: true } },
      },
    }),
  ]);

  const anchor = employee?.previousActiveAt ?? null;

  const greeting: HomeGreeting = {
    firstName: employee?.firstName ?? viewer.firstName,
    /**
     * `positionOther` is the free text someone typed when they picked "Other",
     * and it is the honest answer for them - falling through to null would show
     * a blank where the person has in fact told us what they do.
     */
    positionName: employee?.position?.name ?? employee?.positionOther ?? null,
    departmentName: employee?.department?.name ?? null,
    lastHere:
      anchor === null
        ? null
        : { at: anchor, phrase: describeLastHere(anchor, now) },
  };

  const granted = new Set(me.grantedModuleKeys);

  /**
   * The live reads run together and settle independently.
   *
   * Each resolver converts its own failure into an "unavailable" figure rather
   * than throwing, so a dead Graph credential cannot take the BAS card - or the
   * page - down with it.
   */
  const [coCard, basCard, sinceItems] = await Promise.all([
    granted.has(CHANGE_ORDERS_MODULE_KEY)
      ? changeOrdersCard(me.modules)
      : Promise.resolve(null),
    granted.has(BAS_MODULE_KEY)
      ? basCardFor(viewer, me.modules)
      : Promise.resolve(null),
    anchor === null ? Promise.resolve(null) : collectSince(viewer, granted, anchor),
  ]);

  const byKey = new Map<string, HomeModuleCard>();
  if (coCard !== null) byKey.set(CHANGE_ORDERS_MODULE_KEY, coCard);
  if (basCard !== null) byKey.set(BAS_MODULE_KEY, basCard);

  return {
    greeting,
    /**
     * Ordered by the module registry's own sortOrder, the same order the sidebar
     * uses, so the cards and the nav cannot disagree. A granted module with no
     * card builder yet still gets one, with no figure and its way in intact -
     * adding a module must never produce a Home that silently omits it.
     */
    modules: me.modules.map((module) => byKey.get(module.key) ?? plainCard(module)),
    since: sinceItems,
  };
}

function plainCard(module: MeModule): HomeModuleCard {
  return {
    key: module.key,
    displayName: module.displayName,
    href: `/${module.key}`,
    action: `Open ${module.displayName}`,
    figure: { state: "unavailable", status: "No summary for this module yet" },
  };
}

// --------------------------------------------------------------- change orders

/**
 * Drafts awaiting review.
 *
 * ONE Graph request. `getFolder("drafts")` resolves the well-known alias and
 * returns totalItemCount, so this deliberately does not call listFolders() -
 * that is the eleven-request folder walk, and Home needs one number from one
 * folder.
 *
 * Every failure becomes an "unavailable" figure rather than an exception. Home
 * must render if Exchange is unreachable: the brief is a status line and a way
 * in, never an error page.
 */
async function changeOrdersCard(modules: MeModule[]): Promise<HomeModuleCard> {
  const registered = modules.find((m) => m.key === CHANGE_ORDERS_MODULE_KEY);
  const card = {
    key: CHANGE_ORDERS_MODULE_KEY,
    displayName: registered?.displayName ?? "Change Orders",
    href: `/${CHANGE_ORDERS_MODULE_KEY}`,
    action: "Review drafts",
  };

  const connection = mailboxConnectionStatus();
  if (!connection.configured) {
    /**
     * Not an error: IT has not created the app registration yet. Saying "status
     * unavailable" for something nobody has configured would send an operator
     * looking for a fault that does not exist.
     */
    return {
      ...card,
      figure: { state: "unavailable", status: "Mailbox not connected" },
    };
  }

  try {
    const drafts = await mailService().getFolder("drafts");
    const count = drafts.totalItemCount;

    if (count === 0) {
      return {
        ...card,
        figure: {
          state: "none",
          value: "0",
          status: "No drafts waiting. Nothing needs sending.",
        },
      };
    }

    return {
      ...card,
      figure: {
        state: "ok",
        value: String(count),
        status: count === 1 ? "draft awaiting review" : "drafts awaiting review",
      },
    };
  } catch (error) {
    logger.warn("home.change_orders_figure_failed", {
      moduleKey: CHANGE_ORDERS_MODULE_KEY,
      outcome: "unavailable",
      reason: error instanceof Error ? error.message : "unknown",
    });

    return {
      ...card,
      figure: { state: "unavailable", status: "Status unavailable" },
    };
  }
}

// ------------------------------------------------------------------------ bas

/**
 * Points at risk, and the age of the newest reading - see lib/home/bas-figure.ts
 * for the wording and the rule.
 *
 * Both come from the same service call Collection Health makes, so Home and
 * the BAS screen cannot disagree about either.
 *
 * NO TONE COLOUR ON THE FILL. The card is filled in the module's identity cyan
 * and the fill never changes with state - teal, orange and maroon mean ok,
 * warn and bad on the BAS screen, and a fill in one of them would let the
 * card itself be read as a state. The at-risk headline is marked in maroon
 * ON the card instead (see FigureBlock in app/(platform)/page.tsx): a
 * semantic mark on an identity fill, the two kept distinct rather than one
 * standing in for the other.
 */
async function basCardFor(
  viewer: Viewer,
  modules: MeModule[],
): Promise<HomeModuleCard> {
  const registered = modules.find((m) => m.key === BAS_MODULE_KEY);
  const card = {
    key: BAS_MODULE_KEY,
    displayName: registered?.displayName ?? "Building Automation",
    href: `/${BAS_MODULE_KEY}`,
    action: "Open collection health",
  };

  try {
    const availability = await basDataAvailability();
    if (!availability.available) {
      return {
        ...card,
        figure: { state: "unavailable", status: "BAS data unavailable" },
      };
    }

    const health = await getCollectionHealth(viewer);

    return { ...card, figure: basFigure(health.totals) };
  } catch (error) {
    logger.warn("home.bas_figure_failed", {
      moduleKey: BAS_MODULE_KEY,
      outcome: "unavailable",
      reason: error instanceof Error ? error.message : "unknown",
    });

    return {
      ...card,
      figure: { state: "unavailable", status: "Status unavailable" },
    };
  }
}

// -------------------------------------------------- since you were last here

/**
 * Audit actions that are a change to what this person may do.
 *
 * A deliberate subset, not "everything targeting them". Their own mail actions
 * also carry their id and are not news to them - they did those. What belongs
 * here is what somebody ELSE changed about their access.
 */
const ACCESS_ACTIONS = [
  "grant.added",
  "grant.removed",
  "employee.enabled",
  "employee.disabled",
  "employee.admin_granted",
  "employee.admin_revoked",
] as const;

async function collectSince(
  viewer: Viewer,
  granted: Set<string>,
  since: Date,
): Promise<SinceItem[]> {
  const [messages, gaps, access] = await Promise.all([
    granted.has(CHANGE_ORDERS_MODULE_KEY)
      ? newMessagesSince(since)
      : Promise.resolve(null),
    granted.has(BAS_MODULE_KEY)
      ? newGapsSince(viewer, since)
      : Promise.resolve(null),
    accessChangesSince(viewer, since),
  ]);

  const items: SinceItem[] = [];
  if (messages !== null) items.push(messages);
  if (gaps !== null) items.push(gaps);
  items.push(...access);

  return items;
}

async function newMessagesSince(since: Date): Promise<SinceItem | null> {
  if (!mailboxConnectionStatus().configured) return null;

  try {
    const { count, atLeast } = await mailService().countMessagesSince(
      "inbox",
      since,
    );
    if (count === 0) return null;

    /**
     * "in the change-order mailbox", not "for you". This is the automation's
     * mailbox and most of what lands in it is vendor and pipeline traffic, so a
     * count phrased as personal mail would be a false claim about who it is
     * addressed to.
     */
    const noun = count === 1 && !atLeast ? "message" : "messages";

    return {
      key: "messages",
      text: `${atLeast ? `${count}+` : count} new ${noun} in the change-order mailbox`,
      href: `/${CHANGE_ORDERS_MODULE_KEY}`,
    };
  } catch {
    /**
     * Silent by design. The since-list is a summary, and a line saying the
     * summary could not be built adds nothing the module card above it has not
     * already said in the same words.
     */
    return null;
  }
}

async function newGapsSince(
  viewer: Viewer,
  since: Date,
): Promise<SinceItem | null> {
  try {
    const availability = await basDataAvailability();
    if (!availability.available) return null;

    const health = await getCollectionHealth(viewer);

    /**
     * Dated by `detectedAt`, never by `gapStart`. A gap is recorded once it is
     * discovered, so a silence from last month found this morning is new to the
     * reader - and filtering on when it happened would hide precisely that.
     */
    const fresh = health.dataGaps.filter(
      (gap) => new Date(gap.detectedAt).getTime() > since.getTime(),
    );
    if (fresh.length === 0) return null;

    const noun = fresh.length === 1 ? "gap" : "gaps";

    return {
      key: "gaps",
      text: `${fresh.length} new data ${noun} recorded in Building Automation`,
      href: `/${BAS_MODULE_KEY}`,
    };
  } catch {
    return null;
  }
}

async function accessChangesSince(
  viewer: Viewer,
  since: Date,
): Promise<SinceItem[]> {
  const events = await prisma.auditEvent.findMany({
    where: {
      targetEmployeeId: viewer.id,
      action: { in: [...ACCESS_ACTIONS] },
      occurredAt: { gt: since },
    },
    select: { id: true, action: true, moduleKey: true },
    orderBy: { occurredAt: "desc" },
    take: 5,
  });

  return events.map((event) => ({
    key: `access:${event.id}`,
    text: describeAccessChange(event.action, event.moduleKey),
    href: null,
  }));
}

/**
 * Access changes in the second person.
 *
 * Home is the one place these are read by their subject rather than by an
 * administrator, so the admin log's third-person sentence ("granted X access to
 * Y") would be the wrong voice here.
 */
function describeAccessChange(action: string, moduleKey: string | null): string {
  const named = moduleKey ?? "a module";

  switch (action) {
    case "grant.added":
      return `You were granted access to ${named}`;
    case "grant.removed":
      return `Your access to ${named} was removed`;
    case "employee.enabled":
      return "Your account was enabled";
    case "employee.disabled":
      return "Your account was disabled";
    case "employee.admin_granted":
      return "You were made a platform administrator";
    case "employee.admin_revoked":
      return "Your platform administrator access was removed";
    default:
      /**
       * Unreachable while ACCESS_ACTIONS drives the query, and still not a lie
       * if that ever changes.
       */
      return `Your access changed (${action})`;
  }
}
