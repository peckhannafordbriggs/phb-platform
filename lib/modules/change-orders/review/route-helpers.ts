import type { NextResponse } from "next/server";
import { denialResponse, requireModuleAccess, type Viewer } from "@/lib/authz";
import { CHANGE_ORDERS_MODULE_KEY } from "@/lib/modules/change-orders/constants";
import { ReviewError } from "./errors";
import { reviewErrorResponse, reviewRouteError } from "./http";
import {
  reviewConnectionStatus,
  reviewService,
  type ChangeOrderReviewService,
} from "./service";

/**
 * The wrapper every review route uses, mirroring mail/route-helpers.ts.
 *
 * Because the wrapper is what calls requireModuleAccess, a route cannot be
 * written without the grant check. The Needs Review tab is part of the Change
 * Orders module and keys on the same grant: anyone who may read the mailbox
 * may read the notes about it, and nobody else may.
 *
 * Authorization first, so an unauthenticated caller learns nothing - not even
 * that the folder is unconfigured. Then "is the folder configured", answered
 * once here rather than by each handler, so the tab renders one not-connected
 * state instead of a failure per pane.
 */
export async function withReview(
  route: string,
  handler: (service: ChangeOrderReviewService, viewer: Viewer) => Promise<NextResponse>,
): Promise<NextResponse> {
  const access = await requireModuleAccess(CHANGE_ORDERS_MODULE_KEY);
  if (!access.ok) return denialResponse(access.denial);

  try {
    const status = reviewConnectionStatus();
    if (!status.configured) {
      return reviewErrorResponse(
        new ReviewError("not_configured", {
          detail: `Missing review configuration: ${status.missing.join(", ")}`,
        }),
      );
    }

    return await handler(reviewService(), access.viewer);
  } catch (error) {
    return reviewRouteError(route, error);
  }
}
