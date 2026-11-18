import type { NextResponse } from "next/server";
import { denialResponse, requireModuleAccess, type Viewer } from "@/lib/authz";
import { fail, ok, validationFailed } from "@/lib/api/response";
import { CHANGE_ORDERS_MODULE_KEY } from "@/lib/modules/change-orders/constants";
import {
  captureThrottleRetries,
  RETRY_COUNT_HEADER,
  RETRY_WAIT_HEADER,
} from "@/lib/modules/change-orders/graph/retry-notice";
import { mailRouteError } from "./http";
import { MailError } from "./errors";
import {
  inlineImageSigningKey,
  mailService,
  mailboxConnectionStatus,
} from "./service";
import type { ChangeOrderMailService } from "./service";
import { verifyInlineImageLink } from "./inline-images";

/**
 * The wrapper every mail route uses, mirroring lib/admin/route-helpers.ts.
 *
 * Because the wrapper is what calls requireModuleAccess, a route cannot be
 * written without the grant check - the same reason withAdmin exists. It also
 * means "is the mailbox configured" is answered once, in one place, rather than
 * by each handler remembering to check.
 */
export type ParsedInput<T> =
  | { ok: true; data: T }
  | { ok: false; message?: string };

/**
 * The order of the three steps is deliberate.
 *
 *   1. Authorization. An unauthenticated caller learns nothing else, including
 *      what a valid body would look like.
 *   2. Validation. A malformed request is malformed whether or not the mailbox
 *      happens to be connected, so it is answered honestly - and it means the
 *      write routes' strictness is provable without a live credential.
 *   3. Connectivity. Only then is "the mailbox is not connected" the answer.
 */
export async function withMailbox<T = undefined>(
  route: string,
  handler: (
    service: ChangeOrderMailService,
    viewer: Viewer,
    input: T,
  ) => Promise<NextResponse>,
  parse?: () => Promise<ParsedInput<T>>,
): Promise<NextResponse> {
  const access = await requireModuleAccess(CHANGE_ORDERS_MODULE_KEY);
  if (!access.ok) return denialResponse(access.denial);

  /**
   * Parsing is inside the try, not before it.
   *
   * Phase 8 gave one route a parse step that does real work - reading a
   * multipart body and measuring it - and a parse step that can throw was
   * previously the one path out of this wrapper that produced a bare 500 with an
   * HTML body. Every response from a mail route goes through the same mapping,
   * including the ones from before the handler runs.
   */
  return mailResponse(route, async () => {
    let input = undefined as T;
    if (parse !== undefined) {
      const parsed = await parse();
      if (!parsed.ok) return validationFailed(parsed.message);
      input = parsed.data;
    }

    return handler(connectedMailService(), access.viewer, input);
  });
}

/**
 * The wrapper for the ONE mail route that is not behind the session: the
 * inline-image route the reading pane's sandboxed frame loads images from.
 *
 * The frame has an opaque origin, so the browser sends it no session cookie -
 * measured, not assumed; see ./inline-images.ts. What stands in for the
 * session is a link the grant-gated message route signed for exactly this
 * message and attachment, with an expiry. The signature is checked BEFORE
 * anything else, in the same position the grant check holds in withMailbox: a
 * caller without a valid link learns nothing, not even whether the mailbox is
 * connected. "Expired" is told apart from "invalid" so a person who opens a
 * stale link sees a reason rather than a refusal.
 */
export async function withInlineImageLink(
  route: string,
  request: Request,
  link: { messageId: string; attachmentId: string },
  handler: (service: ChangeOrderMailService) => Promise<NextResponse>,
): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;
  const verdict = verifyInlineImageLink(inlineImageSigningKey(), {
    messageId: link.messageId,
    attachmentId: link.attachmentId,
    exp: params.get("exp"),
    sig: params.get("sig"),
  });

  if (verdict === "expired") {
    return fail(
      403,
      "inline_image_link_expired",
      "This image link has expired. Reopen the message to load its images again.",
    );
  }
  if (verdict !== "valid") {
    return fail(403, "inline_image_link_invalid", "This image link is not valid.");
  }

  return mailResponse(route, async () => handler(connectedMailService()));
}

/**
 * The process-wide service, or the `not_configured` error every mail route
 * reports in the same shape.
 *
 * Not an error, and not a crash. IT creates the app registration on its own
 * schedule; until then every mail route says so in the same shape, and the UI
 * renders one "not configured" state instead of a failure per pane.
 */
function connectedMailService(): ChangeOrderMailService {
  const status = mailboxConnectionStatus();
  if (!status.configured) {
    throw new MailError("not_configured", {
      detail: `Missing Graph configuration: ${status.missing.join(", ")}`,
    });
  }

  return mailService();
}

/**
 * Everything a mail route does runs inside one throttle-retry scope, and every
 * failure leaves through one mapping.
 *
 * A request Graph throttled is retried once inside the middleware chain, after
 * waiting out `Retry-After` - which the browser experiences as a single slow
 * request and nothing else. Capturing it here and answering with a header is
 * what lets the pane say "the mailbox was busy" instead of appearing frozen
 * for no stated reason. It wraps the catch as well as the handler: a route
 * that was throttled and then failed anyway still waited, and still wants to
 * say why.
 */
async function mailResponse(
  route: string,
  run: () => Promise<NextResponse>,
): Promise<NextResponse> {
  const { value, notice } = await captureThrottleRetries(async () => {
    try {
      return await run();
    } catch (error) {
      return mailRouteError(route, error);
    }
  });

  // Absent in the ordinary case rather than zero, so its presence is the signal.
  if (notice !== null) {
    value.headers.set(RETRY_COUNT_HEADER, String(notice.count));
    value.headers.set(RETRY_WAIT_HEADER, String(notice.waitedSeconds));
  }

  return value;
}

/** Bounds a caller-supplied page size before it reaches the service. */
export function readTop(params: URLSearchParams): number | undefined {
  const raw = params.get("top");
  if (raw === null) return undefined;

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * A boolean query parameter.
 *
 * Present-and-not-"0"/"false" is true. A caller that omits it gets `undefined`
 * rather than false, so a route can tell "asked for off" from "did not ask" -
 * which matters for grouping, where the default is on.
 */
export function readFlag(
  params: URLSearchParams,
  name: string,
): boolean | undefined {
  const raw = params.get(name);
  if (raw === null) return undefined;

  const value = raw.trim().toLowerCase();
  return value !== "0" && value !== "false";
}

/** The opaque cursor from a previous page, never a Graph URL. */
export function readCursor(params: URLSearchParams): string | undefined {
  const raw = params.get("cursor")?.trim();
  return raw !== undefined && raw.length > 0 ? raw : undefined;
}

export { ok };
