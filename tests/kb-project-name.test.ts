import { describe, expect, it } from "vitest";
import { projectFromFolder, projectLabel } from "@/lib/modules/knowledge-base/location";

/**
 * A project's name as shown: the job number and the folder's name, without
 * the staging tags the curated folders carry. The real folder names from
 * +++CURATED_FOLDERS on 2026-11-16.
 */
describe("project names from folder names", () => {
  it.each([
    ["218500_CCHMC_CCB_LOC_G_GEN_CONDITIONS_curated_Test2", "218500", "CCHMC CCB LOC G GEN CONDITIONS"],
    ["221457_MAGNODE_Test4", "221457", "MAGNODE"],
    ["224036_CCHMC_EASTGATE_MOB_curated_Test2", "224036", "CCHMC EASTGATE MOB"],
    ["224070_UC_OLD_CHEM_curated_Test2", "224070", "UC OLD CHEM"],
    ["224424_CYRUS_ONE_CIN7_Test2", "224424", "CYRUS ONE CIN7"],
    ["224438_CCHMC_CTC_curated_Test2", "224438", "CCHMC CTC"],
    ["225037_SUNSTAR_TECHNICAL_CENTER_CONSTRUCTION_curated_Test2", "225037", "SUNSTAR TECHNICAL CENTER CONSTRUCTION"],
    ["225215_CVG_CONCOURSE_B_EAST_curated_Test2", "225215", "CVG CONCOURSE B EAST"],
  ])("%s", (folder, projectNumber, projectName) => {
    expect(projectFromFolder(folder)).toEqual({ projectNumber, projectName });
    expect(projectLabel({ projectFolder: folder })).toBe(`${projectNumber} ${projectName}`);
  });

  it("keeps names without tags, and never strips a name to nothing", () => {
    expect(projectFromFolder("221457_MAGNODE")).toEqual({ projectNumber: "221457", projectName: "MAGNODE" });
    expect(projectFromFolder("221457_TESTING_LAB")).toEqual({ projectNumber: "221457", projectName: "TESTING LAB" });
    expect(projectFromFolder("Contest")).toEqual({ projectNumber: null, projectName: "Contest" });
    expect(projectFromFolder("123456_Test2")).toEqual({ projectNumber: "123456", projectName: "Test2" });
  });
});
