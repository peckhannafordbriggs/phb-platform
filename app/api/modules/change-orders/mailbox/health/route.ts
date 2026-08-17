import { denialResponse, requireModuleAccess } from "@/lib/authz";
import { ok } from "@/lib/api/response";
import { logger } from "@/lib/logger";
import { CHANGE_ORDERS_MODULE_KEY } from "@/lib/modules/change-orders/constants";
import { mailRouteError } from "@/lib/modules/change-orders/mail/http";
import {
  mailService,
  mailboxConnectionStatus,
} from "@/lib/modules/change-orders/mail/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/change-orders/mailbox/health";

/**
 * Proof that the backend can reach the Change Order mailbox.
 *
 * Grant-gated like every module route: 401 unauthenticated, 404 without a grant.
 * There is no Change Orders UI in this phase - this endpoint is the phase's
 * observable behaviour, and it stays afterwards as the first thing to check when
 * mail stops working.
 *
 * It constructs no Graph URL and handles no Graph response. Everything it knows
 * about Microsoft 365 it learns from the mail service.
 */
export async function GET() {
  const access = await requireModuleAccess(CHANGE_ORDERS_MODULE_KEY);
  if (!access.ok) return denialResponse(access.denial);

  const status = mailboxConnectionStatus();

  // Not an error. IT creates the Graph app registration on its own schedule, and
  // until then this is the honest answer rather than a 500.
  if (!status.configured) {
    logger.info("mail.health_not_configured", {
      route: ROUTE,
      employeeId: access.viewer.id,
      outcome: "not_configured",
      count: status.missing.length,
    });

    return ok({
      configured: false,
      // Variable names, not values. Naming them is the difference between a
      // five-minute fix and an afternoon of guessing.
      missing: status.missing,
      folders: [],
    });
  }

  try {
    const folders = await mailService().listFolders();

    logger.info("mail.health_ok", {
      route: ROUTE,
      employeeId: access.viewer.id,
      outcome: "ok",
      count: folders.length,
    });

    return ok({
      configured: true,
      mailbox: status.mailbox,
      folders: folders.map((folder) => ({
        displayName: folder.displayName,
        wellKnownName: folder.wellKnownName,
        totalItemCount: folder.totalItemCount,
        unreadItemCount: folder.unreadItemCount,
        parentFolderId: folder.parentFolderId,
      })),
    });
  } catch (error) {
    return mailRouteError(ROUTE, error);
  }
}
