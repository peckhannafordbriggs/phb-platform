/**
 * The stable authorization key for the Knowledge Base module. Authorization
 * always keys on this, never on a display label - the same rule as
 * lib/modules/change-orders/constants.ts.
 *
 * It matches the `knowledge-base` row seeded by prisma/seed.ts and the URL
 * segment of app/(modules)/knowledge-base. Changing it means changing all
 * three, plus every grant already issued.
 */
export const KNOWLEDGE_BASE_MODULE_KEY = "knowledge-base";

/** What the module is called wherever a person reads it. */
export const KNOWLEDGE_BASE_MODULE_NAME = "Knowledge Base";
