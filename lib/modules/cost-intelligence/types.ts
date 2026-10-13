export type Skill = {
  id: string;
  name: string;
  live: string | null;
  versions: string[];
};

/** PCE is the module admin ("Can change settings" on the grant); everyone else with the grant is a Member. */
export type RoleId = "pce" | "member";

export type Role = { id: RoleId; name: string };

/** One row of the role matrix. PCE always has every permission. */
export type Permission = { label: string; roles: RoleId[] };

