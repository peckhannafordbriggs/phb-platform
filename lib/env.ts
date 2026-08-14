import { z } from "zod";

/**
 * Environment is parsed once, at import time, so a misconfigured deployment
 * fails on boot rather than on the first request that happens to need a value.
 *
 * Server-side only. Never import this from a client component - it would leak
 * secrets into the browser bundle.
 */

const nonEmpty = z.string().trim().min(1);

const schema = z.object({
  DATABASE_URL: nonEmpty,

  AUTH_SECRET: nonEmpty,
  AUTH_URL: z.url().optional(),

  AUTH_MICROSOFT_ENTRA_ID_ID: nonEmpty,
  // Local development only. Production authenticates with a managed identity,
  // so this is legitimately absent there.
  AUTH_MICROSOFT_ENTRA_ID_SECRET: z.string().trim().optional(),
  AUTH_MICROSOFT_ENTRA_ID_TENANT_ID: nonEmpty,

  // Comma-separated in the environment; an array everywhere in code.
  ALLOWED_EMAIL_DOMAINS: nonEmpty.transform((raw, ctx) => {
    const domains = raw
      .split(",")
      .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
      .filter((d) => d.length > 0);

    if (domains.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "must list at least one domain",
      });
      return z.NEVER;
    }
    return domains;
  }),

  BOOTSTRAP_ADMIN_EMAIL: z
    .email()
    .transform((e) => e.toLowerCase())
    .optional(),

  // Reserved for Phase 3. Nothing reads it yet; it exists so the variable is in
  // place before the send path that depends on it.
  PHB_ALLOW_SEND: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type Env = z.infer<typeof schema>;

function parseEnv(): Env {
  const result = schema.safeParse(process.env);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `Invalid environment configuration:\n${details}\n\n` +
        `Copy .env.example to .env.local and fill in every value.`,
    );
  }

  return result.data;
}

export const env = parseEnv();

export const isProduction = env.NODE_ENV === "production";
