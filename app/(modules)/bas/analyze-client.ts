import type {
  AnalyzeResult,
  Provenance,
  ResultTable,
} from "@/lib/modules/bas/analyze/types";
import type { Tone } from "./health-client";
import { ApiError } from "./health-client";

/**
 * The browser's view of the Analyze API, plus the pure functions that decide
 * how each outcome is worded and coloured.
 *
 * Separate from the component for the same reason health-client.ts is: the
 * suite has no DOM, and the rules here have to be PROVED - above all that a
 * `no_data` result and an answer whose value is 0 never read the same. See
 * tests/bas-analyze-ui.test.ts.
 */

const BASE = "/api/modules/bas/analyze";

export interface AnalyzeStatus {
  configured: boolean;
  missing: string[];
}

export async function fetchAnalyzeStatus(signal?: AbortSignal): Promise<AnalyzeStatus> {
  const response = await fetch(BASE, { signal, cache: "no-store" }).catch(() => {
    throw new ApiError("network", "Could not reach the server.");
  });
  return unwrap<AnalyzeStatus>(response);
}

export async function askQuestion(
  question: string,
  signal?: AbortSignal,
): Promise<AnalyzeResult> {
  let response: Response;
  try {
    response = await fetch(BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
      signal,
      cache: "no-store",
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError("network", "Could not reach the server.");
  }
  return unwrap<AnalyzeResult>(response);
}

async function unwrap<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => null)) as
    | { data?: T; error?: { code?: string; message?: string } }
    | null;

  if (!response.ok || payload?.error !== undefined) {
    throw new ApiError(
      payload?.error?.code ?? "unexpected",
      payload?.error?.message ?? "Something went wrong.",
    );
  }
  if (payload?.data === undefined) {
    throw new ApiError("unexpected", "The server returned nothing.");
  }
  return payload.data;
}

// ------------------------------------------------------------------ wording

/**
 * The heading over a result. The point of this function is the FIRST TWO
 * cases: a `no_data` result and an `answered` one are different kinds, and
 * they get different words before a reader sees any number.
 */
export function resultHeading(result: AnalyzeResult): string {
  switch (result.kind) {
    case "no_data":
      return "No data matched";
    case "answered":
      return "Answer";
    case "clarify":
      return "One question first";
    case "cannot_answer":
      return "Could not answer";
    case "not_configured":
      return "Analyze is not configured";
  }
}

export function resultTone(result: AnalyzeResult): Tone {
  switch (result.kind) {
    case "no_data":
      // Not an error and not a value. Amber says "read this before deciding".
      return "warn";
    case "answered":
      return "neutral";
    case "clarify":
      return "neutral";
    case "cannot_answer":
      return "warn";
    case "not_configured":
      return "neutral";
  }
}

/**
 * The sentence under the gap figure. Three states, deliberately three
 * sentences, because "0 hours" and "not computed" must never render alike.
 */
export function describeGaps(provenance: Provenance): string {
  if (provenance.gaps === null) {
    if (provenance.timeRange === null && provenance.scope !== "none") {
      return "Gap overlap could not be computed: the query reads readings but no time range was stated. Treat any figure above as unverified.";
    }
    return "Gap overlap does not apply: the query reads no readings.";
  }
  const { totalHours, items } = provenance.gaps;
  if (items.length === 0) {
    return provenance.scope === "all_points"
      ? "No recorded gap overlaps this period for any point."
      : "No recorded gap overlaps this period for the points in scope.";
  }
  const scope =
    provenance.scope === "all_points"
      ? "across every point, because the query did not say which points it reads"
      : `across ${provenance.points.length} point${provenance.points.length === 1 ? "" : "s"}`;
  return `${formatHours(totalHours)} of this period ${items.length === 1 ? "has" : "have"} no readings - ${items.length} recorded gap${items.length === 1 ? "" : "s"}, ${scope}. The platform was not watching; that says nothing about the equipment.`;
}

export function gapsTone(provenance: Provenance): Tone {
  if (provenance.gaps === null) {
    return provenance.timeRange === null && provenance.scope !== "none" ? "warn" : "neutral";
  }
  return provenance.gaps.items.length === 0 ? "ok" : "warn";
}

export function describeUnknownHorizon(provenance: Provenance): string {
  const { count, names } = provenance.unknownHorizon;
  if (count === 0) return "";
  const list = names.slice(0, 4).join(", ") + (names.length > 4 ? ` and ${names.length - 4} more` : "");
  return `${count} point${count === 1 ? "" : "s"} in scope ${count === 1 ? "has" : "have"} an unknown roll horizon (${list}): nobody knows how long the station keeps their history, so records may have been overwritten before collection without anything recording a gap.`;
}

export function describeScope(provenance: Provenance): string {
  switch (provenance.scope) {
    case "none":
      return "This query reads no readings, so no points are in scope.";
    case "all_points":
      return `Every point (${provenance.points.length}) is treated as in scope, because the plan did not name which ones its SQL reads. Figures below are over all of them.`;
    case "declared":
      return `${provenance.points.length} point${provenance.points.length === 1 ? "" : "s"} in scope, as declared by the plan and confirmed to exist.`;
  }
}

export function describeUnclassified(provenance: Provenance): string {
  if (provenance.unclassifiedExcluded === 0) return "";
  return `${provenance.unclassifiedExcluded} collected point${provenance.unclassifiedExcluded === 1 ? " has" : "s have"} no role and ${provenance.unclassifiedExcluded === 1 ? "was" : "were"} outside this search, which selected by what a point measures.`;
}

export function describeRowCount(table: ResultTable): string {
  if (table.truncated) {
    return `First ${table.rowCount} rows of more - the query was capped at ${table.rowCap}.`;
  }
  return `${table.rowCount} row${table.rowCount === 1 ? "" : "s"}`;
}

export function describeTimeRange(
  range: Provenance["timeRange"],
  format: (iso: string) => string = (iso) => iso,
): string {
  if (range === null) return "No time range - the query does not filter by time.";
  return `${format(range.start)} to ${format(range.end)} (UTC as resolved by the plan)`;
}

export function formatHours(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  return `${hours % 1 === 0 ? hours : hours.toFixed(1)} hours`;
}

/**
 * A cell for display. `null` is shown AS the word NULL, in a muted style, and
 * never as an empty string or a dash that could pass for "nothing to show" -
 * a NULL aggregate is the disguised no-data case and it has to be legible.
 */
export function cellText(cell: string | number | boolean | null): string {
  if (cell === null) return "NULL";
  if (typeof cell === "boolean") return cell ? "true" : "false";
  return String(cell);
}

/** What a 429 says to the person. */
export function rateLimitMessage(): string {
  return "Too many questions in a short time. Wait a moment and ask again.";
}
