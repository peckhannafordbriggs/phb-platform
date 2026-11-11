/**
 * THE NAMES of the variables that reach a container from Key Vault by
 * reference and nowhere else, decided here and imported everywhere that reads
 * them: lib/env.ts (which re-exports them, so the web app and its readers
 * import from there as before), lib/modules/bas/analyze/env.ts,
 * lib/modules/bas/credentials.ts, lib/modules/change-orders/anthropic-env.ts,
 * lib/modules/freeze-protection/anthropic-env.ts and the Reports jobs'
 * reader, lib/modules/bas/reports/job-env.ts. infra/main.bicep spells the
 * same names in its `env:` lists, and tests/deploy-guards.test.ts holds them
 * to each other: a rename in one place that misses another fails the build
 * rather than the deployment.
 *
 * A module of its own, with no imports and no side effects, because
 * lib/env.ts parses the WEB APP's boot schema the moment it is imported. A
 * job that wanted only a name paid for the whole schema: the Reports worker
 * imported `readAnthropicApiKey` from lib/env.ts and failed on every Azure
 * execution with `ALLOWED_EMAIL_DOMAINS: Invalid input: expected string,
 * received undefined` (2026-11-11) - a variable the job has no business
 * carrying. A job script, and anything on a job's import path, imports names
 * from HERE and reads values through its own small reader;
 * tests/bas-reports-jobs-env.test.ts walks each job's import graph and fails
 * if lib/env.ts is reachable.
 *
 * BAS_CREDENTIAL_KEY_VERSION rides with the key. It is NOT a secret - a small
 * integer stamped on each credential row at encryption time so a rotation
 * does not need a flag day - and it reaches the container as a plain value.
 * Decryption never reads it; `currentKeyVersion` in credentials.ts does, when
 * a password is saved.
 */
export const ANTHROPIC_API_KEY_VAR = "ANTHROPIC_API_KEY";
/**
 * Change Orders' own key (2026-10-16). Never the SDK default name: the SDK
 * falls back to ANTHROPIC_API_KEY whenever a client is built without
 * `apiKey`, so a change-order client must pass its key explicitly, and the
 * reader never falls back to the BAS key.
 */
export const CO_ANTHROPIC_API_KEY_VAR = "CO_ANTHROPIC_API_KEY";
/**
 * Freeze Protection's own key (2026-11-04), read by the equipment schedule
 * import and nothing else. Same rules as the Change Orders key: never the SDK
 * default name, never a fallback to another module's key.
 */
export const FP_ANTHROPIC_API_KEY_VAR = "FP_ANTHROPIC_API_KEY";
export const BAS_CREDENTIAL_KEY_VAR = "BAS_CREDENTIAL_KEY";
export const BAS_CREDENTIAL_KEY_VERSION_VAR = "BAS_CREDENTIAL_KEY_VERSION";
/** The bas_analyze role's URL (2026-10-13): the third secret by reference, same shape. */
export const BAS_ASK_DATABASE_URL_VAR = "BAS_ASK_DATABASE_URL";
