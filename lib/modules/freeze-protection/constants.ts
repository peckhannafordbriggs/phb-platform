/** Authorization key for the Freeze Protection module. Matches the module row and the URL segment. */
export const FREEZE_PROTECTION_MODULE_KEY = "freeze-protection";

export const FREEZE_PROTECTION_MODULE_NAME = "Freeze Protection";

/**
 * Equipment brought online inside this window needs the verification before
 * startup. Month/day only; the year is whichever season is current, in
 * America/New_York.
 */
export const FREEZE_SEASON = { start: { month: 11, day: 1 }, end: { month: 3, day: 1 } } as const;
