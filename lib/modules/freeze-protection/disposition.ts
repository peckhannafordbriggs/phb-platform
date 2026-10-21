import type { Disposition, FpEquipment, FpTone } from "./types";
import { TESTS } from "./vocab";

/**
 * Where a register line stands, decided in one place.
 *
 * Ported rule for rule from the Controls Division's verification sheet. The order
 * of the checks IS the procedure: a line is judged at the first step it has not
 * passed, so an unanswered coil type hides everything after it.
 *
 * Pure: no dates, no I/O. The register, the overview, the funnel and the report
 * all read this and nothing else, so no two screens can disagree about a line.
 */

const notYetWet = (e: FpEquipment) => e.status === "not_installed" || e.status === "dry";
const noProtection = (e: FpEquipment) => e.protection === "none" || e.protection === "unknown";

export function disposition(e: FpEquipment): Disposition {
  if (!e.coil) return d("coil_open", "open", "Step 2 open", "Coil type not answered.", 2);
  if (e.coil === "none")
    return d("closed_no_coil", "closed", "Closed, no coil", "No water, glycol or steam coil. Closed.", null);

  if (!e.exposure)
    return d("exposure_open", "open", "Step 3 open", "Outside air exposure not answered. A PH+B engineer answers this.", 3);
  if (e.exposure === "no")
    return d(
      "closed_no_exposure",
      "closed",
      "Closed, no exposure",
      "No outside air element could expose the coil to freezing. Closed.",
      null,
    );
  if (e.exposure === "unknown")
    return d("exposure_unknown", "warn", "Exposure unknown", "Outside air exposure unknown. Resolve before cold weather.", 3);

  if (!e.protection) return d("protection_open", "open", "Step 4 open", "Protection not determined.", 4);
  if (noProtection(e)) {
    const told = Boolean(e.notification?.who && e.notification?.date);
    return told
      ? d("no_protection_notified", "bad", "No protection, notified", "No freeze protection. Owner or controls vendor notified.", null)
      : d(
          "no_protection",
          "bad",
          "No protection",
          "No freeze protection. Notify the owner or controls vendor in writing before proceeding.",
          4,
        );
  }

  if (notYetWet(e))
    return d(
      "deferred",
      "open",
      "Test when filled",
      "Exposure and protection recorded. Test required before the system is filled and placed in service.",
      5,
    );

  const answers = e.test.answers;
  const failed = TESTS.filter((t) => answers[t.key] === "no");
  const allAnswered = TESTS.every((t) => answers[t.key]);
  if (failed.length > 0)
    return d("test_failed", "bad", "Test failed", `Test failed: ${failed.map((f) => f.label.toLowerCase()).join("; ")}.`, 5);
  if (!allAnswered) return d("test_open", "open", "Step 5 open", "Safety not yet tested.", 5);

  if (e.protection === "auto")
    return d("deficiency", "warn", "Tested, deficiency", "Freezestat tested and functional, but auto reset. Manual reset required.", null);
  if (e.protection === "software")
    return d("deficiency", "warn", "Tested, deficiency", "Software low limit only. No hardwired safety. Recorded as a deficiency.", null);

  if (!(e.documentation?.with && e.documentation?.date))
    return d(
      "documentation_open",
      "open",
      "Step 6 open",
      "Tested and passed. Written confirmation with the owner or controls vendor still outstanding.",
      6,
    );

  return d("verified", "ok", "Verified", "Safety tested, confirmed and documented.", null);
}

function d(code: Disposition["code"], tone: FpTone, label: string, sentence: string, nextStep: number | null): Disposition {
  return { code, tone, label, sentence, nextStep };
}

/** Which workflow steps a line shows. Mirrors the branching in `disposition`. */
export function visibleSteps(e: FpEquipment) {
  const exposed = Boolean(e.coil && e.coil !== "none" && e.exposure === "yes");
  const protectedOk = exposed && Boolean(e.protection) && !noProtection(e);
  const test = protectedOk && !notYetWet(e);
  const code = disposition(e).code;
  return {
    exposure: Boolean(e.coil && e.coil !== "none"),
    protection: exposed,
    notify: exposed && noProtection(e),
    test,
    deficiency: code === "test_failed" || code === "deficiency",
    documentation: test && TESTS.every((t) => e.test.answers[t.key]),
  };
}

/** The register narrowing to verified. Each stage is a subset of the one before. */
export function funnel(items: FpEquipment[]) {
  const coil = items.filter((e) => e.coil && e.coil !== "none");
  const exposed = coil.filter((e) => e.exposure === "yes");
  const protectedOk = exposed.filter((e) => e.protection && !noProtection(e));
  const verified = exposed.filter((e) => disposition(e).code === "verified");
  return [
    { key: "listed", label: "Listed", count: items.length },
    { key: "coil", label: "Has a coil", count: coil.length },
    { key: "exposed", label: "Outside air exposure", count: exposed.length },
    { key: "protected", label: "Protected", count: protectedOk.length },
    { key: "verified", label: "Verified", count: verified.length },
  ] as const;
}

/** Counts by tone, the figures the overview tiles and the report summary read. */
export function toneCounts(items: FpEquipment[]): Record<FpTone, number> {
  const counts: Record<FpTone, number> = { ok: 0, warn: 0, bad: 0, open: 0, closed: 0 };
  for (const e of items) counts[disposition(e).tone] += 1;
  return counts;
}
