import type { NextResponse } from "next/server";
import { denialResponse, requireModuleAccess, type Viewer } from "@/lib/authz";
import { ok } from "@/lib/api/response";
import { CHANGE_ORDERS_MODULE_KEY } from "@/lib/modules/change-orders/constants";
import { mailErrorResponse, mailRouteError } from "./http";
import { MailError } from "./errors";
import { mailService, mailboxConnectionStatus } from "./service";
import type { ChangeOrderMailService } from "./service";

/**
 * The wrapper every mail route uses, mirroring lib/admin/route-helpers.ts.
 *
 * Because the wrapper is what calls requireModuleAccess, a route cannot be
 * written without the grant check - the same reason withAdmin exists. It also
 * means "is the mailbox configured" is answered once, in one place, rather than
 * by each handler remembering to check.
 */
export async function withMailbox(
  route: string,
  handler: (
    service: ChangeOrderMailService,
    viewer: Viewer,
  ) => Promise<NextResponse>,
): Promise<NextResponse> {
  const access = await requireModuleAccess(CHANGE_ORDERS_MODULE_KEY);
  if (!access.ok) return denialResponse(access.denial);

  // Not an error, and not a crash. IT creates the app registration on its own
  // schedule; until then every mail route says so in the same shape, and the UI
  // renders one "not configured" state instead of a failure per pane.
  const status = mailboxConnectionStatus();
  if (!status.configured) {
    return mailErrorResponse(
      new MailError("not_configured", {
        detail: `Missing Graph configuration: ${status.missing.join(", ")}`,
      }),
    );
  }

  try {
    return await handler(mailService(), access.viewer);
  } catch (error) {
    return mailRouteError(route, error);
  }
}

/** Bounds a caller-supplied page size before it reaches the service. */
export function readTop(params: URLSearchParams): number | undefined {
  const raw = params.get("top");
  if (raw === null) return undefined;

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** The opaque cursor from a previous page, never a Graph URL. */
export function readCursor(params: URLSearchParams): string | undefined {
  const raw = params.get("cursor")?.trim();
  return raw !== undefined && raw.length > 0 ? raw : undefined;
}

export { ok };
