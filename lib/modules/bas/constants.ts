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

/**
 * `?point=none` on Point Explorer: no point is loaded, the person picks.
 *
 * Absent `point` means "the first point the picker offers", and a Dashboard
 * card cannot use that: arriving from a card should show the project's lists
 * and nothing else, so nobody mistakes whichever point happens to sort first
 * for the one they came to look at. Written by `dashboardCardHref` in
 * app/(modules)/bas/filters.ts, read by the point-explorer route, and a point
 * id can never collide with it - ids are digits.
 */
export const NO_POINT = "none";
