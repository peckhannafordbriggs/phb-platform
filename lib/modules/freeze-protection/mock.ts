import type { FpEquipment, FpProject, FpTestResult } from "./types";

/**
 * DESIGN PHASE ONLY. Sample registers so every screen and every disposition can
 * be seen before the tables exist. Delete this file when the service layer lands;
 * nothing outside the module's views may import it.
 *
 * Fictional projects and people. Covers every disposition code at least once.
 */

const EMPTY_TEST: FpTestResult = { answers: {}, tripTempF: null, testedBy: null, testDate: null, elements: null };
const PASSED: FpTestResult["answers"] = { fanStops: "yes", damperCloses: "yes", valveFullFlow: "yes", manualReset: "yes" };

const base = (id: string, projectId: string, name: string, location: string): FpEquipment => ({
  id,
  projectId,
  name,
  location,
  status: "service",
  coil: null,
  exposure: null,
  protection: null,
  test: EMPTY_TEST,
  notification: null,
  deficiency: null,
  documentation: null,
  notes: null,
  updatedAt: "2026-10-20T14:12:00.000Z",
  updatedBy: "Dana Whitfield",
});

export const MOCK_PROJECTS: FpProject[] = [
  {
    id: "p-riverside",
    name: "Riverside Medical Office Building",
    verificationDate: "2026-10-19",
    signoff: {
      completedBy: "Dana Whitfield",
      completedDate: "2026-10-19",
      reviewedBy: null,
      reviewedDate: null,
      transmittedTo: null,
      transmittedDate: null,
    },
  },
  {
    id: "p-northgate",
    name: "Northgate Elementary Addition",
    verificationDate: null,
    signoff: {
      completedBy: null,
      completedDate: null,
      reviewedBy: null,
      reviewedDate: null,
      transmittedTo: null,
      transmittedDate: null,
    },
  },
  {
    id: "p-warehouse",
    name: "Warehouse 7 Fit-out",
    verificationDate: "2026-10-02",
    signoff: {
      completedBy: "Sam Okafor",
      completedDate: "2026-10-02",
      reviewedBy: "Lee Park",
      reviewedDate: "2026-10-05",
      transmittedTo: "Turner CM, J. Alvarez",
      transmittedDate: "2026-10-06",
    },
  },
];

export const MOCK_EQUIPMENT: FpEquipment[] = [
  // Riverside: the full spread.
  {
    ...base("e-ahu1", "p-riverside", "AHU-1", "Penthouse mechanical room"),
    coil: "water",
    exposure: "yes",
    protection: "manual",
    test: { answers: PASSED, tripTempF: "38", testedBy: "Chris Moreno", testDate: "2026-10-16", elements: "1 averaging element" },
    documentation: { with: "owner", name: "R. Patel, facilities", date: "2026-10-17", method: "Email" },
  },
  {
    ...base("e-ahu2", "p-riverside", "AHU-2", "Penthouse mechanical room"),
    coil: "water",
    exposure: "yes",
    protection: "manual",
    test: { answers: PASSED, tripTempF: "37", testedBy: "Chris Moreno", testDate: "2026-10-16", elements: "2 in series, tested separately" },
  },
  {
    ...base("e-rtu3", "p-riverside", "RTU-3", "Roof, east"),
    coil: "steam",
    exposure: "yes",
    protection: "auto",
    test: { answers: PASSED, tripTempF: "40", testedBy: "Chris Moreno", testDate: "2026-10-16", elements: null },
    deficiency: { description: "Auto reset freezestat. Replace with manual reset.", owner: "Controls vendor", due: "2026-11-01" },
  },
  {
    ...base("e-mau1", "p-riverside", "MAU-1", "Kitchen roof"),
    coil: "water",
    exposure: "yes",
    protection: "manual",
    test: {
      answers: { fanStops: "yes", damperCloses: "no", valveFullFlow: "yes", manualReset: "yes" },
      tripTempF: "38",
      testedBy: "Chris Moreno",
      testDate: "2026-10-16",
      elements: null,
    },
    deficiency: { description: "OA damper actuator does not stroke closed on trip.", owner: "PH+B controls", due: "2026-10-24" },
  },
  {
    ...base("e-doas1", "p-riverside", "DOAS-1", "Roof, west"),
    coil: "glycol",
    exposure: "yes",
    protection: "none",
  },
  {
    ...base("e-erv1", "p-riverside", "ERV-1", "Level 2 ceiling"),
    coil: "water",
    exposure: "unknown",
  },
  { ...base("e-vav204", "p-riverside", "VAV-2-04", "Level 2, exam 204"), coil: "water", exposure: "no" },
  { ...base("e-ef2", "p-riverside", "EF-2", "Roof"), coil: "none" },
  { ...base("e-fcu1", "p-riverside", "FCU-1", "Stair 2 vestibule"), status: "filled", coil: "water", exposure: "yes", protection: "manual" },
  { ...base("e-cuh1", "p-riverside", "CUH-1", "Vestibule 100"), coil: "water", exposure: "yes" },

  // Northgate: early, mostly unanswered, much not yet wet.
  { ...base("e-ng-ahu1", "p-northgate", "AHU-1", "Mechanical mezzanine"), status: "dry", coil: "water", exposure: "yes", protection: "manual" },
  { ...base("e-ng-ahu2", "p-northgate", "AHU-2", "Mechanical mezzanine"), status: "not_installed" },
  { ...base("e-ng-uh1", "p-northgate", "UH-1", "Gym storage"), status: "filled", coil: "water" },
  {
    ...base("e-ng-rtu1", "p-northgate", "RTU-1", "Roof, classroom wing"),
    coil: "glycol",
    exposure: "yes",
    protection: "unknown",
    notification: { who: "M. Greene, district facilities", date: "2026-10-14", method: "Letter", response: "Vendor to survey 10/28." },
  },

  // Warehouse: closed out.
  {
    ...base("e-wh-mau1", "p-warehouse", "MAU-1", "Dock 3"),
    coil: "steam",
    exposure: "yes",
    protection: "manual",
    test: { answers: PASSED, tripTempF: "39", testedBy: "Sam Okafor", testDate: "2026-10-01", elements: null },
    documentation: { with: "gc", name: "J. Alvarez", date: "2026-10-02", method: "Email" },
  },
  { ...base("e-wh-uh1", "p-warehouse", "UH-1", "Dock 3"), coil: "steam", exposure: "yes", protection: "drainable", test: { answers: PASSED, tripTempF: null, testedBy: "Sam Okafor", testDate: "2026-10-01", elements: null }, documentation: { with: "gc", name: "J. Alvarez", date: "2026-10-02", method: "Email" } },
  { ...base("e-wh-ef1", "p-warehouse", "EF-1", "Roof"), coil: "none" },
];

export function mockProject(id: string | undefined): FpProject | null {
  return MOCK_PROJECTS.find((p) => p.id === id) ?? null;
}

export function mockEquipmentFor(projectId: string): FpEquipment[] {
  return MOCK_EQUIPMENT.filter((e) => e.projectId === projectId);
}
