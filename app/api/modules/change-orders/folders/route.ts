import { ok } from "@/lib/api/response";
import { withMailbox } from "@/lib/modules/change-orders/mail/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The folder tree, flat, with parentFolderId for the client to nest.
 *
 * Flat rather than nested on purpose: the service walks breadth-first and the
 * client already has to handle a tree that is deeper than it expects. Nesting
 * here would mean two places knew the shape.
 */
export async function GET() {
  return withMailbox("/api/modules/change-orders/folders", async (service) => {
    const folders = await service.listFolders();

    return ok({
      folders: folders.map((folder) => ({
        id: folder.id,
        displayName: folder.displayName,
        parentFolderId: folder.parentFolderId,
        childFolderCount: folder.childFolderCount,
        totalItemCount: folder.totalItemCount,
        unreadItemCount: folder.unreadItemCount,
        wellKnownName: folder.wellKnownName,
      })),
    });
  });
}
