import { Prisma } from "@/lib/generated/prisma/client";
import { prisma } from "@/lib/db";
import { writeAuditEvent, writeAuditEvents, type AuditEventInput } from "@/lib/audit";
import { BAS_MODULE_KEY } from "./constants";
import { equipmentKey, groupEquipmentPrefixes, groupIncludedByDefault } from "./name-prefix";
import { readableName, suggestClassification, type EquipmentFacts, type RoleFacts } from "./suggestions";
import { planStationPieces, stationUnit } from "./station-equipment";
import { countChangesByStation, hideDuplicateCopies, runDuplicatePass, type DuplicatePass } from "./auto-hide";
import type { StationAssignment, StationAssignmentOutcome } from "./types";

export type { StationAssignment, StationAssignmentOutcome } from "./types";

/**
 * The automatic assignment pass (2026-11-19).
 *
 * Every pass of the BAS Reports scheduler job (scripts/bas-reports-scheduler.ts,
 * every fifteen minutes) and every "Run assignment now" press in Settings runs
 * THIS code, station by station: for each collected point that a person has not
 * classified and that is missing its role or its equipment, it
 *
 *   0. (2026-11-23) when the STATION is named for a unit or a plant -
 *      CEI_AHU_7, CEI_PLANT - attaches the station's points to that
 *      equipment (lib/modules/bas/station-equipment.ts): created once, named
 *      after the token (`AHU_7`, `PLANT`), or the building's existing
 *      equipment of that name, EVEN IF another station's points are on it -
 *      the station's own name is the evidence that the JACE's `AHU_7/...`
 *      and CEI_AHU_7's points are one air handler. Points this claims skip
 *      step 1;
 *   1. creates the equipment a HIGH-confidence name prefix implies, one per
 *      prefix per station, named as the integrator wrote it (`V4_22`,
 *      `AHU_7`) - or attaches to equipment of that name already on the
 *      building, unless another station's points are on it (a second JACE's
 *      `V1_01` is not provably the same box: a person decides);
 *   2. applies every HIGH-confidence role suggestion, decided with the
 *      equipment from step 1 in view (a VAV's DaTemp is discharge air, an
 *      AHU's is supply air);
 *   3. stamps `assignment_source = 'auto'` on each point it wrote, and writes
 *      one `bas.point_auto_assigned` row per point saying what and why.
 *
 * THEN, DEAD DUPLICATE COPIES (2026-11-23, lib/modules/bas/auto-hide.ts): for
 * every building with more than one station, a point that reads one value
 * over the last seven days while the point its name matches on another
 * station varies is hidden as a copy of it - CEI_JCI_N2's AHU_7/DA_SAP of
 * CEI_AHU_7's DA_SAP. "Run assignment now" does the same for its station's
 * pairs. Never a point a person showed or hid (hidden_source 'manual').
 *
 * MEDIUM STAYS UNASSIGNED. A medium suggestion is a guess a person should
 * look at; it stays on the row under "Needs a decision" as a one-click
 * choice. So does a point no pattern speaks for.
 *
 * WHAT IT NEVER DOES, each enforced in the UPDATE itself and not only in the
 * plan, so a person's write that lands between the read and the write wins:
 *
 *   - write a point whose `assignment_source` is 'manual' (a person touched
 *     it through Settings; manual beats auto, for the whole point);
 *   - write a half that is not NULL (fill only, per half, as the two
 *     name-derived previews of #133 do - nothing is ever overwritten or
 *     cleared);
 *   - write an uncollected point.
 *
 * IDEMPOTENT AND CHEAP. A station with no candidate point costs nothing past
 * one aggregate query for the whole pass. A station whose candidates yield
 * nothing - CEI's enthalpy points, whose role the vocabulary does not have -
 * is read once and written nothing: no transaction, no lock, no audit row.
 * Only a station with something to write opens a transaction, and inside it
 * the station row is locked (so two passes on one station run one after the
 * other), the facts are read again and the plan is made again from them.
 *
 * ENVIRONMENT-FREE. The scheduler job imports this, and nothing a job runs
 * may reach lib/env.ts or read process.env past the database client
 * (tests/bas-reports-jobs-env.test.ts). So no Analyze cache reset here: the
 * web route that calls this drops it after; the scheduler's writes reach the
 * Analyze catalogue when its five-minute cache next expires.
 */

const TRANSACTION = { timeout: 60_000, maxWait: 10_000 } as const;

export type AutoAssignTrigger =
  | { kind: "scheduler" }
  | { kind: "run_now"; actorEmployeeId: string };

export interface AssignmentPass {
  at: string;
  stations: StationAssignment[];
  failed: Array<{ stationId: string; stationName: string; error: string }>;
  /** The duplicate-copy step, per building (2026-11-23). Its counts are also on each station above. */
  duplicates: DuplicatePass;
}

// ---------------------------------------------------------------------------
// The facts a plan is made from
// ---------------------------------------------------------------------------

type Db = Prisma.TransactionClient | typeof prisma;

interface CandidateRow {
  point_id: bigint;
  niagara_history_name: string;
  display_name: string | null;
  label: string | null;
  unit: string | null;
  data_type: string;
  point_role: string | null;
  equipment_id: bigint | null;
  equipment_type: string | null;
}

interface BuildingEquipmentRow {
  equipment_id: bigint;
  name: string;
  equip_type: string | null;
}

interface StationFacts {
  stationId: bigint;
  stationName: string;
  /** Niagara's name for the station: what step 0 reads. */
  niagaraStationName: string;
  /** Every collected point's readable name on the station: a bare PLANT's type is decided over all of them. */
  collectedNames: string[];
  siteId: bigint | null;
  candidates: CandidateRow[];
  roles: Map<string, RoleFacts>;
  equipmentTypes: Set<string>;
  building: BuildingEquipmentRow[];
  /** Equipment on the building with points on ANOTHER station. Not attached to automatically. */
  sharedElsewhere: Set<string>;
}

/**
 * The predicate a point must meet to be touched at all. Written once and
 * used by the candidate query, the pass's station query and every UPDATE.
 */
const CANDIDATE = (p: Prisma.Sql) => Prisma.sql`
  ${p}.is_active
  AND ${p}.assignment_source IS DISTINCT FROM 'manual'
  AND (${p}.point_role IS NULL OR ${p}.equipment_id IS NULL)`;

async function loadFacts(db: Db, stationId: bigint): Promise<StationFacts | null> {
  const station = await db.$queryRaw<Array<{ site_id: bigint | null; name: string; niagara_station_name: string }>>`
    SELECT site_id, COALESCE(display_name, niagara_station_name) AS name, niagara_station_name
      FROM bas_stations WHERE station_id = ${stationId}`;
  const found = station[0];
  if (found === undefined) return null;
  // Only a plant whose type its points decide needs every name on the station.
  const unit = stationUnit(found.niagara_station_name);
  const collected =
    unit !== null && unit.kind === "plant" && unit.equipType === null
      ? await db.$queryRaw<Array<{ niagara_history_name: string; display_name: string | null }>>`
          SELECT niagara_history_name, display_name FROM bas_points
           WHERE station_id = ${stationId} AND is_active`
      : [];

  const [candidates, roles, types, building, shared] = await Promise.all([
    db.$queryRaw<CandidateRow[]>`
      SELECT p.point_id, p.niagara_history_name, p.display_name, p.label, p.unit,
             p.data_type, p.point_role, p.equipment_id, e.equip_type AS equipment_type
        FROM bas_points p
        LEFT JOIN bas_equipment e ON e.equipment_id = p.equipment_id
       WHERE p.station_id = ${stationId}
         AND ${CANDIDATE(Prisma.sql`p`)}
       ORDER BY p.niagara_history_name`,
    db.$queryRaw<Array<{ point_role: string; display_name: string; typical_unit: string | null }>>`
      SELECT point_role, display_name, typical_unit FROM bas_point_roles`,
    db.$queryRaw<Array<{ equip_type: string }>>`SELECT equip_type FROM bas_equipment_types`,
    found.site_id === null
      ? Promise.resolve([] as BuildingEquipmentRow[])
      : db.$queryRaw<BuildingEquipmentRow[]>`
          SELECT equipment_id, name, equip_type FROM bas_equipment WHERE site_id = ${found.site_id}`,
    found.site_id === null
      ? Promise.resolve([] as Array<{ equipment_id: bigint }>)
      : db.$queryRaw<Array<{ equipment_id: bigint }>>`
          SELECT DISTINCT p.equipment_id
            FROM bas_points p
            JOIN bas_equipment e ON e.equipment_id = p.equipment_id
           WHERE e.site_id = ${found.site_id}
             AND p.station_id <> ${stationId}`,
  ]);

  return {
    stationId,
    stationName: found.name,
    niagaraStationName: found.niagara_station_name,
    collectedNames: collected.map((c) =>
      readableName({ niagaraHistoryName: c.niagara_history_name, niagaraDisplayName: c.display_name }),
    ),
    siteId: found.site_id,
    candidates,
    roles: new Map(
      roles.map((r) => [r.point_role, { pointRole: r.point_role, displayName: r.display_name, typicalUnit: r.typical_unit }]),
    ),
    equipmentTypes: new Set(types.map((t) => t.equip_type)),
    building,
    sharedElsewhere: new Set(shared.map((s) => s.equipment_id.toString())),
  };
}

// ---------------------------------------------------------------------------
// The plan: pure, from the facts
// ---------------------------------------------------------------------------

interface PlannedEquipment {
  key: string;
  name: string;
  equipType: string | null;
  /** Equipment already on the building with this key; null: create it. */
  existingId: bigint | null;
  reason: string;
  spellings: string[];
}

interface RolePlan {
  role: string;
  roleName: string | null;
  pattern: string;
  level: string;
  reason: string;
}

interface StationPlan {
  equipment: Map<string, PlannedEquipment>;
  /** Point id -> equipment key to attach it to. */
  attach: Map<string, string>;
  /** Point id -> role to give it. */
  roles: Map<string, RolePlan>;
}

const pointName = (r: CandidateRow) =>
  readableName({ niagaraHistoryName: r.niagara_history_name, niagaraDisplayName: r.display_name });

function planStation(facts: StationFacts): StationPlan {
  const equipment = new Map<string, PlannedEquipment>();
  const attach = new Map<string, string>();
  const roles = new Map<string, RolePlan>();
  const byKey = new Map<string, BuildingEquipmentRow>();
  for (const e of facts.building) if (!byKey.has(equipmentKey(e.name))) byKey.set(equipmentKey(e.name), e);

  // A planned piece of equipment, or null when it must be left to a person.
  // `fromStation`: the station is named for this unit, which settles that
  // equipment of that name elsewhere on the building is the same unit.
  const target = (
    key: string,
    name: string,
    equipType: string | null,
    reason: string,
    spellings: string[],
    fromStation = false,
  ): PlannedEquipment | null => {
    const planned = equipment.get(key);
    if (planned !== undefined) return planned;
    const existing = byKey.get(key);
    let next: PlannedEquipment;
    if (existing !== undefined) {
      if (!fromStation && facts.sharedElsewhere.has(existing.equipment_id.toString())) return null;
      next = {
        key,
        name: existing.name,
        equipType: existing.equip_type,
        existingId: existing.equipment_id,
        reason: `${existing.name} already exists on this building; the point is attached to it.`,
        spellings,
      };
    } else {
      if (equipType === null || !facts.equipmentTypes.has(equipType)) return null;
      next = { key, name, equipType, existingId: null, reason, spellings };
    }
    equipment.set(key, next);
    return next;
  };

  // 0. The station is the equipment (2026-11-23): CEI_AHU_7, CEI_PLANT.
  // Only points with no equipment, and only on a building.
  const claimed = new Set<string>();
  const unit = facts.siteId === null ? null : stationUnit(facts.niagaraStationName);
  if (unit !== null) {
    const pieces = planStationPieces(
      unit,
      facts.collectedNames.map((name) => ({ name })),
      facts.candidates
        .filter((r) => r.equipment_id === null)
        .map((r) => ({ pointId: r.point_id.toString(), name: pointName(r) })),
    );
    for (const piece of pieces) {
      const planned = target(equipmentKey(piece.name), piece.name, piece.equipType, piece.reason, [piece.name], true);
      if (planned === null) continue;
      for (const id of piece.pointIds) {
        attach.set(id, planned.key);
        claimed.add(id);
      }
    }
  }

  // 1. Equipment from high-confidence prefixes. Equipment lives on a
  // building, so a station on none takes the role half only.
  if (facts.siteId !== null) {
    const groups = groupEquipmentPrefixes(
      facts.candidates.filter((r) => !claimed.has(r.point_id.toString())).map((r) => ({
        pointId: r.point_id.toString(),
        name: pointName(r),
        collected: true,
        equipmentId: r.equipment_id?.toString() ?? null,
      })),
      facts.building.map((e) => ({ equipmentId: e.equipment_id.toString(), name: e.name, equipType: e.equip_type })),
    );
    for (const group of groups) {
      // High confidence: a unit of a known type, or one that already exists.
      // I/O modules and unknown prefixes wait for a person in the preview.
      if (!groupIncludedByDefault(group)) continue;
      const planned = target(group.key, group.name, group.equipType, group.typeReason, group.spellings);
      if (planned === null) continue;
      for (const id of group.pointIds) attach.set(id, planned.key);
    }
  }

  // 2. Roles, with the equipment from step 1 in view.
  const known: EquipmentFacts[] = facts.building.map((e) => ({ equipmentId: e.equipment_id.toString(), name: e.name }));
  for (const row of facts.candidates) {
    const id = row.point_id.toString();
    const plannedKey = attach.get(id);
    const planned = plannedKey === undefined ? undefined : equipment.get(plannedKey);
    const suggestion = suggestClassification(
      {
        niagaraHistoryName: row.niagara_history_name,
        niagaraDisplayName: row.display_name,
        unit: row.unit,
        pointRole: row.point_role,
        // The equipment it has, else the equipment it is about to get: the
        // engine reads the TYPE from it, and asks no equipment half of a point
        // that will have one.
        equipmentId: row.equipment_id?.toString() ?? (planned === undefined ? null : `planned:${planned.key}`),
        equipmentType: row.equipment_id !== null ? row.equipment_type : (planned?.equipType ?? null),
        collected: true,
        dataType: row.data_type,
      },
      facts.roles,
      known,
    );
    if (suggestion === null || suggestion.level !== "high") continue;

    if (suggestion.role !== null && row.point_role === null) {
      roles.set(id, {
        role: suggestion.role,
        roleName: suggestion.roleName,
        pattern: suggestion.pattern,
        level: suggestion.level,
        reason: suggestion.confidence,
      });
    }
    // The B8.5 VAV phrase pattern names its box; the prefixes usually got it
    // first, and this is the case they did not.
    if (
      suggestion.equipmentName !== null &&
      row.equipment_id === null &&
      planned === undefined &&
      facts.siteId !== null
    ) {
      const key = equipmentKey(suggestion.equipmentName);
      const next = target(key, suggestion.equipmentName, suggestion.equipType, suggestion.confidence, [suggestion.equipmentName]);
      if (next !== null) attach.set(id, next.key);
    }
  }

  return { equipment, attach, roles };
}

const planIsEmpty = (plan: StationPlan) => plan.attach.size === 0 && plan.roles.size === 0;

// ---------------------------------------------------------------------------
// The write
// ---------------------------------------------------------------------------

function actorOf(trigger: AutoAssignTrigger): string | null {
  return trigger.kind === "run_now" ? trigger.actorEmployeeId : null;
}

async function countNeedDecision(db: Db, stationId: bigint): Promise<number> {
  const rows = await db.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM bas_points
     WHERE station_id = ${stationId} AND is_active AND point_role IS NULL`;
  return Number(rows[0]?.n ?? 0);
}

async function writePlan(
  tx: Prisma.TransactionClient,
  facts: StationFacts,
  plan: StationPlan,
  trigger: AutoAssignTrigger,
): Promise<StationAssignment> {
  const actorEmployeeId = actorOf(trigger);
  const rowsById = new Map(facts.candidates.map((r) => [r.point_id.toString(), r]));
  const created: string[] = [];
  const idByKey = new Map<string, bigint>();

  // Create only the equipment some point will actually be attached to.
  const used = new Set(plan.attach.values());
  for (const planned of plan.equipment.values()) {
    if (!used.has(planned.key)) continue;
    if (planned.existingId !== null) {
      idByKey.set(planned.key, planned.existingId);
      continue;
    }
    const row = await tx.basEquipment.create({
      data: { siteId: facts.siteId!, name: planned.name, equipType: planned.equipType },
      select: { equipmentId: true },
    });
    idByKey.set(planned.key, row.equipmentId);
    created.push(planned.name);
    await writeAuditEvent(tx, {
      action: "bas.equipment_created",
      actorEmployeeId,
      moduleKey: BAS_MODULE_KEY,
      metadata: {
        equipmentId: row.equipmentId.toString(),
        siteId: facts.siteId!.toString(),
        name: planned.name,
        equipType: planned.equipType,
        parentEquipmentId: null,
        parentName: null,
        notes: null,
        source: "auto",
        trigger: trigger.kind,
        stationId: facts.stationId.toString(),
        spellings: planned.spellings,
        reason: planned.reason,
      },
    });
  }

  // Equipment, one UPDATE per piece, each re-checking the rule.
  const attached = new Set<string>();
  const byEquipment = new Map<string, bigint[]>();
  for (const [pointId, key] of plan.attach) {
    const list = byEquipment.get(key) ?? [];
    list.push(BigInt(pointId));
    byEquipment.set(key, list);
  }
  for (const [key, ids] of byEquipment) {
    const equipmentId = idByKey.get(key)!;
    const moved = await tx.$queryRaw<Array<{ point_id: bigint }>>`
      UPDATE bas_points p
         SET equipment_id = ${equipmentId}, assignment_source = 'auto'
       WHERE p.point_id IN (${Prisma.join(ids)})
         AND p.equipment_id IS NULL
         AND ${CANDIDATE(Prisma.sql`p`)}
      RETURNING p.point_id`;
    for (const m of moved) attached.add(m.point_id.toString());
  }

  // Roles, one UPDATE per role.
  const given = new Set<string>();
  const byRole = new Map<string, bigint[]>();
  for (const [pointId, plan_] of plan.roles) {
    const list = byRole.get(plan_.role) ?? [];
    list.push(BigInt(pointId));
    byRole.set(plan_.role, list);
  }
  for (const [role, ids] of byRole) {
    const moved = await tx.$queryRaw<Array<{ point_id: bigint }>>`
      UPDATE bas_points p
         SET point_role = ${role}, assignment_source = 'auto'
       WHERE p.point_id IN (${Prisma.join(ids)})
         AND p.point_role IS NULL
         AND ${CANDIDATE(Prisma.sql`p`)}
      RETURNING p.point_id`;
    for (const m of moved) given.add(m.point_id.toString());
  }

  // One row per point written, with the reason for each half.
  const touched = [...new Set([...attached, ...given])].sort();
  const rows: AuditEventInput[] = touched.map((pointId) => {
    const row = rowsById.get(pointId)!;
    const role = given.has(pointId) ? plan.roles.get(pointId)! : null;
    const key = attached.has(pointId) ? plan.attach.get(pointId)! : null;
    const equipment = key === null ? null : plan.equipment.get(key)!;
    return {
      action: "bas.point_auto_assigned",
      actorEmployeeId,
      moduleKey: BAS_MODULE_KEY,
      metadata: {
        pointId,
        stationId: facts.stationId.toString(),
        siteId: facts.siteId?.toString() ?? null,
        niagaraHistoryName: row.niagara_history_name,
        niagaraDisplayName: row.display_name,
        label: row.label,
        pointName: pointName(row),
        trigger: trigger.kind,
        role:
          role === null
            ? null
            : { role: role.role, roleName: role.roleName, previousRole: null, pattern: role.pattern, level: role.level, reason: role.reason },
        equipment:
          equipment === null
            ? null
            : {
                equipmentId: idByKey.get(equipment.key)!.toString(),
                name: equipment.name,
                equipType: equipment.equipType,
                created: equipment.existingId === null,
                previousEquipmentId: null,
                reason: equipment.reason,
              },
      },
    };
  });
  await writeAuditEvents(tx, rows);

  const result: StationAssignment = {
    stationId: facts.stationId.toString(),
    stationName: facts.stationName,
    outcome: touched.length > 0 || created.length > 0 ? "assigned" : "no_change",
    candidates: facts.candidates.length,
    pointsAssigned: touched.length,
    roleAssigned: given.size,
    equipmentAttached: attached.size,
    equipmentCreated: created,
    needDecision: await countNeedDecision(tx, facts.stationId),
    duplicatesHidden: 0,
    duplicatesShown: 0,
  };
  // A press of the button writes its summary after the duplicate step, in
  // autoAssignStation, so the one row carries both.
  if (result.outcome === "assigned" && trigger.kind === "scheduler") await writeSummary(tx, facts, result, trigger);
  return result;
}

async function writeSummary(
  db: Db,
  facts: { stationId: bigint; siteId: bigint | null },
  result: StationAssignment,
  trigger: AutoAssignTrigger,
): Promise<void> {
  await writeAuditEvent(db, {
    action: "bas.auto_assignment_ran",
    actorEmployeeId: actorOf(trigger),
    moduleKey: BAS_MODULE_KEY,
    metadata: {
      stationId: result.stationId,
      stationName: result.stationName,
      siteId: facts.siteId?.toString() ?? null,
      trigger: trigger.kind,
      outcome: result.outcome,
      candidates: result.candidates,
      pointsAssigned: result.pointsAssigned,
      roleAssigned: result.roleAssigned,
      equipmentAttached: result.equipmentAttached,
      equipmentCreated: result.equipmentCreated,
      needDecision: result.needDecision,
      duplicatesHidden: result.duplicatesHidden,
      duplicatesShown: result.duplicatesShown,
    },
  });
}

/**
 * One station. Throws when the station does not exist; the Settings route
 * checks the viewer may see it first.
 */
export async function autoAssignStation(stationId: bigint, trigger: AutoAssignTrigger): Promise<StationAssignment> {
  const facts = await loadFacts(prisma, stationId);
  if (facts === null) throw new Error(`station ${stationId} does not exist`);

  const quiet = async (outcome: StationAssignmentOutcome): Promise<StationAssignment> => ({
    stationId: stationId.toString(),
    stationName: facts.stationName,
    outcome,
    candidates: facts.candidates.length,
    pointsAssigned: 0,
    roleAssigned: 0,
    equipmentAttached: 0,
    equipmentCreated: [],
    needDecision: await countNeedDecision(prisma, stationId),
    duplicatesHidden: 0,
    duplicatesShown: 0,
  });

  const result =
    facts.candidates.length === 0
      ? await quiet("nothing_to_assign")
      : planIsEmpty(planStation(facts))
        ? await quiet("no_change")
        : await prisma.$transaction(async (tx) => {
            // Two passes on one station - the scheduler and a press of the
            // button - run one after the other, and the second plans from what
            // the first wrote.
            await tx.$queryRaw`SELECT station_id FROM bas_stations WHERE station_id = ${stationId} FOR UPDATE`;
            const fresh = await loadFacts(tx, stationId);
            if (fresh === null) throw new Error(`station ${stationId} does not exist`);
            return writePlan(tx, fresh, planStation(fresh), trigger);
          }, TRANSACTION);

  // The scheduler runs the duplicate step once per building, after every
  // station (runAutoAssignPass). A press of the button runs it here, for this
  // station's pairs, and records the press - even one that found nothing to do.
  if (trigger.kind === "run_now") {
    if (facts.siteId !== null) {
      // Everything the press changed, wherever the point is: pressed on
      // CEI_AHU_7, the copies it hides are on CEI_JCI_N2.
      const changes = await hideDuplicateCopies({ siteId: facts.siteId, stationId }, trigger);
      result.duplicatesHidden = changes.filter((c) => c.kind === "hidden").length;
      result.duplicatesShown = changes.filter((c) => c.kind === "shown").length;
    }
    await writeSummary(prisma, facts, result, trigger);
  }
  return result;
}

/**
 * Every station, once. A station that fails is reported and the others still
 * run; the scheduler exits non-zero if any did, so the execution reads Failed.
 */
export async function runAutoAssignPass(now: Date = new Date()): Promise<AssignmentPass> {
  const stations = await prisma.$queryRaw<
    Array<{ station_id: bigint; name: string; candidates: bigint; need_decision: bigint }>
  >`
    SELECT st.station_id,
           COALESCE(st.display_name, st.niagara_station_name) AS name,
           count(p.point_id) FILTER (WHERE ${CANDIDATE(Prisma.sql`p`)}) AS candidates,
           count(p.point_id) FILTER (WHERE p.is_active AND p.point_role IS NULL) AS need_decision
      FROM bas_stations st
      LEFT JOIN bas_points p ON p.station_id = st.station_id
     GROUP BY st.station_id
     ORDER BY st.station_id`;

  const pass: AssignmentPass = {
    at: now.toISOString(),
    stations: [],
    failed: [],
    duplicates: { buildings: 0, changes: [], failed: [] },
  };
  for (const station of stations) {
    if (Number(station.candidates) === 0) {
      // Skipped without another query.
      pass.stations.push({
        stationId: station.station_id.toString(),
        stationName: station.name,
        outcome: "nothing_to_assign",
        candidates: 0,
        pointsAssigned: 0,
        roleAssigned: 0,
        equipmentAttached: 0,
        equipmentCreated: [],
        needDecision: Number(station.need_decision),
        duplicatesHidden: 0,
        duplicatesShown: 0,
      });
      continue;
    }
    try {
      pass.stations.push(await autoAssignStation(station.station_id, { kind: "scheduler" }));
    } catch (error) {
      pass.failed.push({
        stationId: station.station_id.toString(),
        stationName: station.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Dead duplicate copies, per building, after every station's roles: one
  // query for the buildings, then per building its names and ONE aggregate.
  pass.duplicates = await runDuplicatePass(now);
  const counts = countChangesByStation(pass.duplicates.changes);
  for (const station of pass.stations) {
    const entry = counts.get(station.stationId);
    station.duplicatesHidden = entry?.hidden ?? 0;
    station.duplicatesShown = entry?.shown ?? 0;
  }
  return pass;
}
