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
