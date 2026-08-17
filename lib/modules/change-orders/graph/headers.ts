import type { FetchOptions } from "@microsoft/microsoft-graph-client";

/**
 * Header helpers for the middleware chain.
 *
 * The Graph SDK hands middleware a `headers` value typed as HeadersInit, which
 * is three different runtime shapes. The SDK's own helpers for this are not part
 * of its public entry point, so these are ours - and they are total, rather than
 * assuming the plain-object case the SDK happens to produce today.
 */

export function setHeader(
  options: FetchOptions | undefined,
  key: string,
  value: string,
): void {
  if (options === undefined) return;

  const existing = options.headers;

  if (existing instanceof Headers) {
    existing.set(key, value);
    return;
  }

  if (Array.isArray(existing)) {
    const lower = key.toLowerCase();
    const kept = existing.filter(([name]) => name?.toLowerCase() !== lower);
    kept.push([key, value]);
    options.headers = kept;
    return;
  }

  if (existing === undefined) {
    options.headers = { [key]: value };
    return;
  }

  const record: Record<string, string> = {};
  for (const [name, current] of Object.entries(existing)) {
    if (name.toLowerCase() !== key.toLowerCase()) record[name] = current;
  }
  record[key] = value;
  options.headers = record;
}

export function getHeader(
  options: FetchOptions | undefined,
  key: string,
): string | null {
  const existing = options?.headers;
  if (existing === undefined) return null;

  if (existing instanceof Headers) return existing.get(key);

  const lower = key.toLowerCase();

  if (Array.isArray(existing)) {
    const found = existing.find(([name]) => name?.toLowerCase() === lower);
    return found?.[1] ?? null;
  }

  for (const [name, value] of Object.entries(existing)) {
    if (name.toLowerCase() === lower) return value;
  }

  return null;
}
