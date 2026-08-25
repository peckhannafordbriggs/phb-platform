import path from "node:path";
import { config as loadEnv } from "dotenv";

/**
 * Loads .env.local for a script, as a side effect, on import.
 *
 * A module of its own because ordering is load-bearing here. `lib/env.ts` parses
 * `process.env` at IMPORT time so a misconfigured deployment fails on boot
 * rather than on the first request that needs a value - which means anything
 * reaching it from a script has to have the environment in place before that
 * import is evaluated.
 *
 * ES modules evaluate imports in source order, so importing this FIRST is what
 * makes the rest work. Inlining these two lines at the top of a script would not:
 * the statements would run after every import in the file had already been
 * evaluated, and `lib/env.ts` would have thrown by then.
 *
 * scripts/db.ts does the same thing for the seed scripts, and deliberately keeps
 * its own copy - it must be usable with no Entra app registration configured.
 */
loadEnv({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });
loadEnv({ path: path.resolve(process.cwd(), ".env"), quiet: true });
