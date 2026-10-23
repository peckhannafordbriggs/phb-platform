import type { ConfirmedWith, CoilType, EquipmentStatus, Exposure, Protection, TestKey } from "./types";

/** Every label a person reads for a stored value, in one place. Order is display order. */

export const STATUS_LABEL: Record<EquipmentStatus, string> = {
  not_installed: "Not installed",
  dry: "Installed, dry",
  filled: "Installed, filled",
  service: "In service",
};

export const COIL_LABEL: Record<CoilType, string> = {
  none: "No water, glycol or steam coil",
  water: "Water",
  glycol: "Glycol",
  steam: "Steam",
};

export const EXPOSURE_LABEL: Record<Exposure, string> = {
  yes: "Yes, outside air can reach the coil",
  no: "No outside air element",
  unknown: "Unknown",
};

/** Short form for tables, where the full sentence does not fit. */
export const EXPOSURE_SHORT: Record<Exposure, string> = { yes: "Yes", no: "No", unknown: "Unknown" };

export const PROTECTION_LABEL: Record<Protection, string> = {
  manual: "Manual reset freezestat",
  auto: "Auto reset freezestat",
  software: "Software low limit only",
  glycol: "Glycol, no freezestat",
  drainable: "Drainable coil",
  none: "None",
  unknown: "Unknown",
};

export const TESTS: readonly { key: TestKey; label: string }[] = [
  { key: "fanStops", label: "Supply fan stops on trip" },
  { key: "damperCloses", label: "Outside air damper drives closed" },
  { key: "valveFullFlow", label: "Heating or cooling valve drives to full flow" },
  { key: "manualReset", label: "Reset requires a manual reset" },
];

export const CONFIRMED_WITH_LABEL: Record<ConfirmedWith, string> = {
  owner: "Owner or facility team",
  vendor: "Controls vendor",
  gc: "General contractor or CM",
  rental: "Rental vendor",
};

/** Who answers each step. Shown beside the step heading. */
export const STEP_OWNER: Record<number, string | undefined> = {
  1: "Project manager, with the facility and controls teams",
  3: "PH+B engineer",
  5: "Controls team",
};

/**
 * The closed vocabularies as lists, for validation. Derived from the label
 * records so a value cannot be accepted without a label to show for it. The
 * migration's CHECK constraints hold the same lists; tests/fp-schema.test.ts
 * reads them back and compares.
 */
const keys = <T extends string>(record: Record<T, string>) => Object.keys(record) as [T, ...T[]];
export const STATUS_VALUES = keys(STATUS_LABEL);
export const COIL_VALUES = keys(COIL_LABEL);
export const EXPOSURE_VALUES = keys(EXPOSURE_LABEL);
export const PROTECTION_VALUES = keys(PROTECTION_LABEL);
export const CONFIRMED_WITH_VALUES = keys(CONFIRMED_WITH_LABEL);
