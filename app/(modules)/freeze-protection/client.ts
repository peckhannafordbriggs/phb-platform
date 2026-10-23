/**
 * The browser's side of the module API. Every call returns a result rather than
 * throwing, with the server's own sentence on a refusal, so a view can show
 * "Main has 12 units. Move or remove them first." instead of a status code.
 */

const BASE = "/api/modules/freeze-protection";

export type CallResult<T> = { ok: true; data: T } | { ok: false; message: string };

export async function call<T = unknown>(
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<CallResult<T>> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as
      | { data: T }
      | { error: { message: string } }
      | null;
    if (res.ok && json && "data" in json) return { ok: true, data: json.data };
    if (json && "error" in json) return { ok: false, message: json.error.message };
    return { ok: false, message: "Something went wrong. Try again." };
  } catch {
    return { ok: false, message: "Could not reach the platform. Check your connection and try again." };
  }
}
