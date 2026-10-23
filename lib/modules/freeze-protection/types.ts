/**
 * The shape of a freeze protection register, ported from the Controls Division's
 * verification sheet. These types drive the screens; the Prisma models are written
 * to match them, not the other way round.
 *
 * Date-only values are `YYYY-MM-DD` strings. Never parse them into a Date in the
 * browser's zone; they show the day before.
 */

/** Where the unit is in its life. "Not yet wet" (not installed, dry) defers the test. */
export type EquipmentStatus = "not_installed" | "dry" | "filled" | "service";

/** Step 2. `none` closes the line: nothing to freeze. */
export type CoilType = "none" | "water" | "glycol" | "steam";

/** Step 3, answered by a PH+B engineer. `no` closes the line; `unknown` is unresolved. */
export type Exposure = "yes" | "no" | "unknown";

/** Step 4. `none` and `unknown` stop work until the owner or vendor is notified. */
export type Protection = "manual" | "auto" | "software" | "glycol" | "drainable" | "none" | "unknown";

/** Step 5. Every one must be answered; any `no` is a failed test. */
export type TestKey = "fanStops" | "damperCloses" | "valveFullFlow" | "manualReset";
export type YesNo = "yes" | "no";

/** Step 6. Who the passing result was confirmed with in writing. */
export type ConfirmedWith = "owner" | "vendor" | "gc" | "rental";

export type FpTestResult = {
  answers: Partial<Record<TestKey, YesNo>>;
  tripTempF: string | null;
  testedBy: string | null;
  testDate: string | null;
  /** Free text: which sensing elements, when more than one is wired in series. */
  elements: string | null;
};

/** Recorded when there is no protection. Step 4's stop. */
export type FpNotification = {
  who: string | null;
  date: string | null;
  method: string | null;
  response: string | null;
};

/** Recorded on a failed test or a deficiency (auto reset, software low limit only). */
export type FpDeficiency = {
  description: string | null;
  owner: string | null;
  due: string | null;
};

export type FpDocumentation = {
  with: ConfirmedWith | null;
  name: string | null;
  date: string | null;
  method: string | null;
};

/** A building on a project. Every unit belongs to one. */
export type FpBuilding = {
  id: string;
  name: string;
  equipmentCount: number;
};

/** A construction job. Identified by its job number; linked to nothing else. */
export type FpProject = {
  id: string;
  jobNumber: string;
  name: string;
  buildings: FpBuilding[];
};

/** A project as the picker lists it. */
export type FpProjectSummary = {
  id: string;
  jobNumber: string;
  name: string;
  equipmentCount: number;
  /** The newest round's date, or null when the project has none yet. */
  latestVerificationDate: string | null;
};

/** Who signed, and when. The signer is the signed-in employee, never typed. */
export type FpSignature = {
  employeeId: string | null;
  name: string;
  at: string;
};

/**
 * One verification round on a project. The report speaks for `verificationDate`.
 * Step 7: `completed` is the person who carried it out, `reviewed` a different
 * engineer.
 */
export type FpVerification = {
  id: string;
  projectId: string;
  verificationDate: string;
  completed: FpSignature | null;
  reviewed: FpSignature | null;
  transmittedTo: string | null;
  transmittedDate: string | null;
  /**
   * True when anything in the round changed after it was reviewed. Nothing is
   * locked (decision 2026-10-22); the report says so instead, because the sheet
   * requires a new review after any later change.
   */
  changedAfterReview: boolean;
};

/**
 * One line in a round's register: the unit (from the equipment schedule) and
 * its result in this round. Null means "not answered yet".
 */
export type FpLine = {
  /** The equipment id: stable across rounds. */
  id: string;
  /** This round's result row. */
  resultId: string;
  buildingId: string;
  buildingName: string;
  tag: string;
  equipmentType: string | null;
  areaServed: string | null;
  coil: CoilType | null;
  equipmentNotes: string | null;
  status: EquipmentStatus;
  exposure: Exposure | null;
  protection: Protection | null;
  test: FpTestResult;
  notification: FpNotification | null;
  deficiency: FpDeficiency | null;
  documentation: FpDocumentation | null;
  notes: string | null;
  updatedAt: string;
  updatedBy: string | null;
};

/**
 * The state a line is in, as a tone. Semantic, never the module accent:
 * ok = teal, warn = orange, bad = maroon, open = waiting on a step, closed = nothing to do.
 * Every tone is always paired with words; orange is also this module's identity.
 */
export type FpTone = "ok" | "warn" | "bad" | "open" | "closed";

export type DispositionCode =
  | "coil_open"
  | "closed_no_coil"
  | "exposure_open"
  | "closed_no_exposure"
  | "exposure_unknown"
  | "protection_open"
  | "no_protection"
  | "no_protection_notified"
  | "deferred"
  | "test_open"
  | "test_failed"
  | "deficiency"
  | "documentation_open"
  | "verified";

export type Disposition = {
  code: DispositionCode;
  tone: FpTone;
  /** Two or three words, for a pill. */
  label: string;
  /** One sentence, for the detail pane and the report. */
  sentence: string;
  /** The step a person acts on next, 1 to 6, or null when the line is closed or verified. */
  nextStep: number | null;
};
