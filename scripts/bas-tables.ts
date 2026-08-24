/**
 * The table-by-table definition of the BAS import, shared by the script that
 * performs it and the script that verifies it.
 *
 * One definition, deliberately. A verifier with its own copy of the table list
 * is a verifier that can silently stop covering a table the import still moves.
 */

/**
 * The move, in dependency order. Parents before children, so every foreign key
 * has something to point at.
 *
 * `columns` are the SOURCE column names. Target columns are identical - the
 * translation renamed tables, never columns - which is what makes this a
 * straight copy rather than a mapping exercise.
 *
 * `deferred` columns are self-references. They are written as NULL on the first
 * pass and filled in by an UPDATE afterwards, because a row can reference
 * another row of the same table that has not been inserted yet. The alternative
 * would be deferrable constraints, which Prisma does not emit.
 */
export interface TableMove {
  source: string;
  target: string;
  columns: string[];
  deferred?: string[];
  /** Primary key column whose sequence must be advanced after an explicit-id insert. */
  sequenceColumn?: string;
  /** Key used to match rows for the deferred UPDATE. */
  keyColumn?: string;
  /**
   * Columns that uniquely identify a row, used to order the content checksum
   * and to name the rows that differ. Not the same as keyColumn: this is a
   * composite for the tables whose identity is composite, and it exists for
   * every table rather than only the ones with self-references.
   */
  verifyKey: string[];
}

export const MOVES: TableMove[] = [
  {
    source: "equipment_type",
    verifyKey: ["equip_type"],
    target: "bas_equipment_types",
    columns: ["equip_type", "display_name", "description", "category"],
  },
  {
    source: "point_role",
    verifyKey: ["point_role"],
    target: "bas_point_roles",
    columns: [
      "point_role", "display_name", "description", "measurement", "typical_unit",
      "is_setpoint", "is_command", "is_status", "setpoint_for", "status_of",
    ],
    deferred: ["setpoint_for", "status_of"],
    keyColumn: "point_role",
  },
  {
    source: "org",
    verifyKey: ["org_id"],
    target: "bas_orgs",
    columns: ["org_id", "name", "notes", "created_at"],
    sequenceColumn: "org_id",
  },
  {
    source: "site",
    verifyKey: ["site_id"],
    target: "bas_sites",
    columns: [
      "site_id", "org_id", "name", "address", "timezone", "area_sqft",
      "attributes", "notes", "created_at",
    ],
    sequenceColumn: "site_id",
  },
  {
    source: "station",
    verifyKey: ["station_id"],
    target: "bas_stations",
    columns: [
      "station_id", "site_id", "niagara_station_name", "base_url", "host_id",
      "model", "niagara_version", "parent_station_id", "is_active", "notes",
      "first_seen_at", "last_seen_at",
    ],
    deferred: ["parent_station_id"],
    keyColumn: "station_id",
    sequenceColumn: "station_id",
  },
  {
    source: "equipment",
    verifyKey: ["equipment_id"],
    target: "bas_equipment",
    columns: [
      "equipment_id", "site_id", "name", "equip_type", "parent_equipment_id",
      "attributes", "notes", "created_at",
    ],
    deferred: ["parent_equipment_id"],
    keyColumn: "equipment_id",
    sequenceColumn: "equipment_id",
  },
  {
    // roll_horizon_s is deliberately absent. It is maintained in the target by
    // the bas_points_roll_horizon trigger, which recomputes it from capacity and
    // collection_interval_s - both of which are copied - so nothing is lost.
    //
    // It was a GENERATED ALWAYS column when this list was written, which
    // REJECTED a direct write. The trigger silently OVERWRITES one instead, so
    // adding it here would no longer fail: it would just be ignored, and the
    // content check would pass because the trigger computed the right answer
    // anyway. Leave it out.
    source: "point",
    verifyKey: ["point_id"],
    target: "bas_points",
    columns: [
      "point_id", "station_id", "equipment_id", "niagara_history_name",
      "niagara_history_ord", "display_name", "point_role", "unit", "data_type",
      "source_timezone", "collection_interval_s", "capacity", "full_policy",
      "tags", "notes", "is_active", "first_seen_at", "last_seen_at",
    ],
    sequenceColumn: "point_id",
  },
  {
    source: "reading",
    verifyKey: ["point_id", "ts"],
    target: "bas_readings",
    columns: ["point_id", "ts", "value_num", "value_bool", "value_str", "status"],
  },
  {
    source: "point_link",
    verifyKey: ["from_point_id", "to_point_id", "link_type"],
    target: "bas_point_links",
    columns: [
      "from_point_id", "to_point_id", "link_type", "confidence", "notes", "created_at",
    ],
  },
  {
    source: "sync_checkpoint",
    verifyKey: ["point_id"],
    target: "bas_sync_checkpoints",
    columns: [
      "point_id", "last_record_ts", "last_run_at", "last_status",
      "consecutive_failures", "last_error",
    ],
  },
  {
    source: "ingest_run",
    verifyKey: ["run_id"],
    target: "bas_ingest_runs",
    columns: [
      "run_id", "station_id", "started_at", "finished_at", "status",
      "window_start", "window_end", "points_attempted", "points_succeeded",
      "records_written", "errors", "collector_version", "collector_host",
    ],
    sequenceColumn: "run_id",
  },
  {
    source: "data_gap",
    verifyKey: ["gap_id"],
    target: "bas_data_gaps",
    columns: [
      "gap_id", "point_id", "gap_start", "gap_end", "detected_at", "cause", "notes",
    ],
    sequenceColumn: "gap_id",
  },
];
