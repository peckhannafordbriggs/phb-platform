/**
 * Placeholder skills for the search bar until real search exists. Delete this
 * file then. TODO(backend).
 */
import type { Skill } from "./types";

export const PLACEHOLDER_SKILLS: Skill[] = [
  {
    id: "phb-bid-kickoff",
    name: "Bid kickoff",
    live: "v1.4.0",
    versions: ["v1.2.0", "v1.3.0", "v1.3.1", "v1.4.0"],
  },
  {
    id: "phb-estimate-population",
    name: "Estimate population",
    live: "v2.3.1",
    versions: ["v2.0.0", "v2.1.0", "v2.2.0", "v2.3.0", "v2.3.1"],
  },
  {
    id: "phb-estimate-qa",
    name: "Estimate QA",
    live: null,
    versions: [],
  },
  {
    id: "phb-jv-summary",
    name: "JV partner summary",
    live: "v1.0.0",
    versions: ["v1.0.0"],
  },
  {
    id: "phb-legacy-import",
    name: "Legacy CE import",
    live: null,
    versions: ["v1.0.0"],
  },
];
