import { describe, expect, it } from "vitest";
import { parseFileName, pickLatest } from "@/lib/modules/knowledge-base/naming";

/**
 * File names are real ones from the curated 224070_UC_OLD_CHEM project.
 * Names only: no document content.
 */

function candidates(names: string[]) {
  return names.map((name) => ({ path: `11 - SUBMITTALS/${name}`, parsed: parseFileName(name) }));
}

describe("parseFileName", () => {
  it("reads family, status and date from a current submittal", () => {
    expect(parseFileName("224070_SUB_Air_Valves_Approved_20241121.pdf")).toEqual({
      familyKey: "224070_SUB_Air_Valves",
      versionLabel: "20241121",
      versionRank: 20241121,
      status: "Approved",
      archived: false,
    });
  });

  it("puts an ARCHIVE_ version in the same family", () => {
    expect(parseFileName("ARCHIVE_224070_SUB_Air_Valves_Rejected_20240119.pdf")).toMatchObject({
      familyKey: "224070_SUB_Air_Valves",
      status: "Rejected",
      archived: true,
    });
  });

  it("reads a vNN version", () => {
    expect(parseFileName("210733_SPEC_23_07_19_HVAC_Piping_Insulation_v02.docx")).toMatchObject({
      familyKey: "210733_SPEC_23_07_19_HVAC_Piping_Insulation",
      versionLabel: "v02",
      versionRank: 2,
      status: null,
    });
  });

  it("keeps description words that are not status words", () => {
    // `Estimate` is part of the description, so the estimate and the CO are two families.
    expect(parseFileName("224070_COR_CO_008_Bulletin_12_Estimate_20240605.xlsx").familyKey).toBe(
      "224070_COR_CO_008_Bulletin_12_Estimate",
    );
    expect(parseFileName("224070_COR_CO_008_Bulletin_12_20240605.pdf").familyKey).toBe(
      "224070_COR_CO_008_Bulletin_12",
    );
  });

  it("gives a name off the naming sheet its whole stem as the family", () => {
    expect(parseFileName("+ATTENTION_CO_LOG_MISMATCH.txt")).toEqual({
      familyKey: "+ATTENTION_CO_LOG_MISMATCH",
      versionLabel: null,
      versionRank: null,
      status: null,
      archived: false,
    });
  });

  it("does not read an inherited object property as a status word", () => {
    expect(parseFileName("224070_SUB_constructor_20240101.pdf")).toMatchObject({
      familyKey: "224070_SUB_constructor",
      status: null,
    });
  });
});

describe("pickLatest", () => {
  it("takes the newest non-archived version", () => {
    const family = candidates([
      "ARCHIVE_224070_SUB_Air_Valves_Rejected_20240119.pdf",
      "ARCHIVE_224070_SUB_Air_Valves_Approved_20240419.pdf",
      "224070_SUB_Air_Valves_Approved_20241121.pdf",
      "ARCHIVE_224070_SUB_Air_Valves_Approved_20240717.pdf",
    ]);
    expect(pickLatest(family)?.path).toBe("11 - SUBMITTALS/224070_SUB_Air_Valves_Approved_20241121.pdf");
  });

  it("never picks an archived file, even one with the same name and date", () => {
    const family = candidates([
      "ARCHIVE_224070_COR_CO_008_Bulletin_12_20240605.pdf",
      "224070_COR_CO_008_Bulletin_12_20240605.pdf",
    ]);
    expect(pickLatest(family)?.parsed.archived).toBe(false);
  });

  it("returns null when every version is archived", () => {
    const family = candidates([
      "ARCHIVE_224070_SUB_Exhaust_Attenuators_Approved_20240710.pdf",
      "ARCHIVE_224070_SUB_Exhaust_Attenuators_Approved_20240718.pdf",
    ]);
    expect(pickLatest(family)).toBeNull();
  });

  it("prefers the executed copy over the unexecuted one of the same date", () => {
    const names = [
      "224070_SUBK_AMERAIR_Balancing_Unexecuted_20240110.pdf",
      "224070_SUBK_AMERAIR_Balancing_Executed_20240110.pdf",
    ];
    expect(pickLatest(candidates(names))?.parsed.status).toBe("Executed");
    expect(pickLatest(candidates([...names].reverse()))?.parsed.status).toBe("Executed");
  });

  it("lets a newer date win over a better status", () => {
    const family = candidates([
      "224070_SUBK_AMERAIR_Balancing_Executed_20240110.pdf",
      "224070_SUBK_AMERAIR_Balancing_Unexecuted_20240301.pdf",
    ]);
    expect(pickLatest(family)?.parsed.versionLabel).toBe("20240301");
  });

  it("chooses the same file whatever order the listing arrives in", () => {
    const names = ["224070_X_A_20240101.pdf", "224070_X_A_20240101.PDF"];
    expect(pickLatest(candidates(names))?.path).toBe(pickLatest(candidates([...names].reverse()))?.path);
  });
});
