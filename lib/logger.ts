/**
 * Structured logging. One JSON object per line, so a log aggregator can filter
 * on any field without parsing prose.
 *
 * docs/07-conventions.md forbids logging message bodies, attachment content,
 * access or refresh tokens, secrets, API keys, and full recipient lists. None of
 * those are fields here; nothing in this file stringifies an arbitrary object,
 * so a caller cannot leak one by passing the wrong argument.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  requestId?: string;
  employeeId?: string | null;
  route?: string;
  method?: string;
  outcome?: string;
  status?: number;
  durationMs?: number;
  reason?: string;
  moduleKey?: string;
  count?: number;
  /**
   * The Analyze tab (BAS B5). The question a person typed and the SQL that ran
   * for it - docs/BAS-B5.md requires every query logged with both, because the
   * log is how anyone learns what people actually ask and how a wrong answer
   * is audited afterwards. Neither is on the docs/07 forbidden list: a question
   * about sensor data is not a message body, and the SQL is ours to see.
   */
  question?: string;
  sql?: string;
  /** Analyze: whether any SQL reached the database. `sql` alone cannot say. */
  queried?: boolean;
  /**
   * Sign-in (lib/auth/entra-token-error.ts). Entra's token-endpoint error
   * body, copied field by field from a whitelist - the AADSTS code and the
   * ids Microsoft support asks for. Never a token: Entra's error body has
   * none, and the whitelist would drop one if it did.
   */
  entraError?: string;
  entraErrorCode?: string;
  entraErrorDescription?: string;
  entraTraceId?: string;
  entraCorrelationId?: string;
  entraTimestamp?: string;
}

function emit(level: LogLevel, event: string, fields: LogFields = {}): void {
  const line = JSON.stringify({
    level,
    event,
    time: new Date().toISOString(),
    ...fields,
  });

  if (level === "error" || level === "warn") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (event: string, fields?: LogFields) => emit("debug", event, fields),
  info: (event: string, fields?: LogFields) => emit("info", event, fields),
  warn: (event: string, fields?: LogFields) => emit("warn", event, fields),
  error: (event: string, fields?: LogFields) => emit("error", event, fields),
};

/**
 * Server-side diagnostics are detailed; the browser gets a generic message.
 * This is the only place an unexpected error is unpacked, and it never returns
 * the detail to the caller.
 */
export function logUnexpected(
  event: string,
  error: unknown,
  fields: LogFields = {},
): void {
  const detail =
    error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : { name: "unknown", message: String(error) };

  console.error(
    JSON.stringify({
      level: "error",
      event,
      time: new Date().toISOString(),
      ...fields,
      error: detail,
    }),
  );
}
