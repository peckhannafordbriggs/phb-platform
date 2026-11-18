/**
 * The header helpers moved to lib/mail/headers.ts on 2026-11-17, when the
 * Graph client became shared with the BAS report sender. Re-exported here so
 * every existing import keeps its path.
 */
export { getHeader, setHeader } from "@/lib/mail/headers";
