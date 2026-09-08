import { z } from "zod";

/**
 * What the Settings forms may send (B7.3).
 *
 * Shape only. Whether a project exists, whether a name is already taken and
 * whether a timezone is one PostgreSQL knows are questions the service answers,
 * because they need the database - and a validator that guessed at them would
 * be a second, quieter copy of the rules.
 *
 * IDs are strings, not numbers. `bas_projects.project_id` and
 * `bas_sites.site_id` are PostgreSQL `bigint`, and parsing one through a JS
 * number rounds silently past 2^53. They are carried as strings and converted
 * with `BigInt` at the edge, the same way `parseSiteId` already does.
 */

/** A bigint that arrived as text. Digits only - anything else is not an id. */
const bigintText = z
  .string()
  .trim()
  .regex(/^[0-9]+$/, "That is not a valid id.")
  .max(20);

/**
 * Trimmed, and non-empty AFTER trimming.
 *
 * A name of three spaces passes a naive `min(1)` and then renders as a blank
 * row nobody can click. The transform runs before the length check because Zod
 * applies them in order.
 */
const displayName = z
  .string()
  .trim()
  .min(1, "Enter a name.")
  .max(120, "Names are limited to 120 characters.");

/** Optional free text. An empty string is stored as NULL, not as "". */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value.length === 0 ? null : value))
    .nullable()
    .optional();

/**
 * An IANA timezone name, shape-checked here and existence-checked in the
 * service against `pg_timezone_names`.
 *
 * Both halves are needed. This regex accepts `America/Nowhere`, which is not a
 * zone; the database check accepts `EST5EDT`, which is a zone but not one
 * anybody should be storing. Neither alone is the rule.
 *
 * It matters more than it looks. `bas_sites.timezone` is what converts stored
 * UTC back to "what time was it in the building", which is the only frame an
 * occupancy schedule makes sense in. A wrong zone does not error - it shifts
 * every local timestamp on the Point Explorer by a whole number of hours and
 * looks entirely plausible.
 */
const timezone = z
  .string()
  .trim()
  .min(1, "Choose a timezone.")
  .max(64)
  .regex(
    /^[A-Za-z][A-Za-z0-9+_-]*(\/[A-Za-z0-9+_-]+)*$/,
    "That is not an IANA timezone name, e.g. America/New_York.",
  );

export const createProjectSchema = z.object({
  orgId: bigintText,
  name: displayName,
  notes: optionalText(2000),
});

/**
 * Edit carries only what changes. `notes` absent means "leave it"; `notes: null`
 * means "clear it" - which is why `optionalText` is nullable AND optional
 * rather than one or the other.
 */
export const updateProjectSchema = z.object({
  name: displayName.optional(),
  notes: optionalText(2000),
});

export const createBuildingSchema = z.object({
  projectId: bigintText,
  name: displayName,
  timezone,
  address: optionalText(500),
  notes: optionalText(2000),
});

export const updateBuildingSchema = z.object({
  name: displayName.optional(),
  timezone: timezone.optional(),
  address: optionalText(500),
  notes: optionalText(2000),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
export type CreateBuildingInput = z.infer<typeof createBuildingSchema>;
export type UpdateBuildingInput = z.infer<typeof updateBuildingSchema>;

// ---------------------------------------------------------------------------
// Stations (B7.4)
// ---------------------------------------------------------------------------

/**
 * The Niagara station name, and the ONE field in this file that is not trimmed.
 *
 * It appears literally in every oBIX URL and it is case-sensitive:
 * `SpringGroveLabComputer` is the live value, and `springgrovelabcomputer` 404s
 * every request. `.trim()` looks harmless and is not - a trailing space that a
 * person typed is part of what Niagara answers to, or it is not, and this
 * schema is not the place that gets to decide. Whatever was typed is what is
 * stored, and a mismatch shows up as a station that returns nothing rather than
 * as a value silently rewritten here.
 *
 * The length bound and the "not blank" check still apply. Neither alters the
 * value.
 */
const niagaraStationName = z
  .string()
  .min(1, "Enter the Niagara station name.")
  .max(120)
  .refine((v) => v.trim().length > 0, "Enter the Niagara station name.");

/**
 * The oBIX base URL, also stored verbatim.
 *
 * The live value is `https://196.1.1.213` with NO trailing slash. Adding one
 * produces `//obix` in every URL the collector builds. A trailing slash the
 * person typed is left alone for the same reason - this is not the layer that
 * knows how the collector concatenates.
 */
const baseUrl = z
  .string()
  .trim()
  .min(1, "Enter the station address.")
  .max(500)
  .refine(
    (v) => /^https?:\/\//i.test(v),
    "The address must start with http:// or https://.",
  );

/**
 * SHA-256 of the TLS certificate: 64 hex characters.
 *
 * Normalised, unlike the two above, and the difference is the point. A
 * fingerprint is a number written in hex, so `AB:CD` and `abcd` are the same
 * number - colons and case are presentation. Workbench and openssl each print
 * it their own way, and someone pasting from either should not have to know
 * which. The station name and the URL are identifiers whose exact bytes matter;
 * this is a value whose bytes do not.
 */
const tlsSha256 = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s:]/g, "").toLowerCase())
  .refine(
    (v) => v.length === 0 || /^[0-9a-f]{64}$/.test(v),
    "A certificate fingerprint is 64 hex characters. Colons are ignored.",
  )
  .transform((v) => (v.length === 0 ? null : v))
  .nullable()
  .optional();

const connectionMode = z.enum(["direct", "via_parent"]);

/**
 * The form requires what the shape implies; the DATABASE deliberately does not.
 *
 * B7.1 allows `via_parent` with no parent, because that is exactly what a JACE
 * linked in Workbench and not yet labelled here looks like, and B7.2 renders it
 * amber as "discovered, unassigned". A CHECK constraint enforcing this would
 * make those rows impossible to store, which would hide the very thing the
 * amber exists to surface.
 *
 * So it is enforced HERE, on the way in through a form, and nowhere else. A row
 * that arrives any other way is allowed to be incomplete and is shown as such.
 */
function requireModeFields<T extends {
  connectionMode: "direct" | "via_parent";
  baseUrl?: string | null;
  parentStationId?: string | null;
}>(value: T, ctx: z.RefinementCtx): void {
  if (value.connectionMode === "direct") {
    if (value.baseUrl === undefined || value.baseUrl === null || value.baseUrl === "") {
      ctx.addIssue({
        code: "custom",
        path: ["baseUrl"],
        message: "A direct station needs an address.",
      });
    }
  } else if (
    value.parentStationId === undefined ||
    value.parentStationId === null ||
    value.parentStationId === ""
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["parentStationId"],
      message: "Choose the station that imports this one's history.",
    });
  }
}

export const createStationSchema = z
  .object({
    siteId: bigintText,
    niagaraStationName,
    displayName: optionalText(120),
    connectionMode,
    baseUrl: baseUrl.nullable().optional(),
    parentStationId: bigintText.nullable().optional(),
    tlsSha256,
    notes: optionalText(2000),
    /** Optional at creation - a station can be registered before anyone has the login. */
    username: optionalText(200),
    password: z.string().min(1).max(1000).nullable().optional(),
  })
  .superRefine(requireModeFields);

export const updateStationSchema = z
  .object({
    niagaraStationName: niagaraStationName.optional(),
    displayName: optionalText(120),
    connectionMode: connectionMode.optional(),
    baseUrl: baseUrl.nullable().optional(),
    parentStationId: bigintText.nullable().optional(),
    tlsSha256,
    notes: optionalText(2000),
    isActive: z.boolean().optional(),
  });

/**
 * Setting a credential. Its own route and its own schema, because it is the one
 * payload in this file that carries a secret.
 *
 * `password` is required here - this endpoint exists to replace it. Clearing a
 * credential is DELETE on the same path, which is a different intent and should
 * not be spelled as an empty string somebody might submit by accident.
 */
export const setCredentialSchema = z.object({
  username: z.string().trim().min(1, "Enter the username.").max(200),
  password: z.string().min(1, "Enter the password.").max(1000),
});

export type CreateStationInput = z.infer<typeof createStationSchema>;
export type UpdateStationInput = z.infer<typeof updateStationSchema>;
export type SetCredentialInput = z.infer<typeof setCredentialSchema>;
