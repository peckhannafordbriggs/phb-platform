/**
 * The stable authorization key for the Building Automation module. Authorization
 * always keys on this, never on a display label - the same rule as
 * lib/modules/change-orders/constants.ts.
 *
 * It matches the `bas` row seeded by prisma/seed.ts and the URL segment of both
 * app/(modules)/bas and app/api/modules/bas. Changing it means changing all
 * four, plus every grant already issued.
 */
export const BAS_MODULE_KEY = "bas";
