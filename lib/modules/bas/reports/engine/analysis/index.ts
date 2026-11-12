/**
 * Which library question has an analysis function (Reports, Phase 2), and
 * which waits for Phase 5.
 *
 * `analysis_fn` on a library row is the key here. A question whose key maps
 * to `not_built` is still DECIDED - Not Applicable or Not Monitored, from the
 * inventory - and, when it could run, reported as not run in this phase
 * rather than silently dropped. A question that maps to `derived` is
 * answered from the other questions' results (the two Summary questions).
 */
export type AnalysisAvailability = "built" | "derived" | "not_built";

export const ANALYSIS_AVAILABILITY: Readonly<Record<string, AnalysisAvailability>> = {
  q01_building_status: "derived",
  q02_changes_since_last: "derived",
  q03_zone_comfort: "built",
  q04_worst_zones: "built",
  q05_manual_overrides: "built",
  q06_vav_starved_airflow: "not_built",
  q07_vav_damper_full_missed_setpoint: "not_built",
  q08_reheat_open_above_cooling_sp: "not_built",
  q09_dat_holds_setpoint: "not_built",
  q10_static_tracks_setpoint: "not_built",
  q11_simultaneous_heating_cooling: "not_built",
  q12_economizer_at_minimum: "not_built",
  q13_hw_supply_and_delta_t: "not_built",
  q14_chw_supply_and_delta_t: "not_built",
  q15_compressor_short_cycling: "not_built",
  q16_dx_cooling_delta: "not_built",
  q17_compressors_during_economizer: "not_built",
  q18_heat_stage_delta: "not_built",
  q19_run_outside_schedule: "built",
  q20_data_health: "built",
};

export const NOT_BUILT_NOTE = "The analysis for this question is built in Phase 5. Its points were checked and it could run.";

export {
  dataHealth,
  incidentPoints,
  incidentMinute,
  COLLECTION_STOPPED,
  DATA_HEALTH_QUESTION,
  INCIDENT_CAUSES,
  INCIDENT_MIN_POINTS,
  INCIDENT_WINDOW_MS,
  PHYSICAL_RANGES,
  physicalRangeFor,
} from "./data-health";
export { zoneComfort, COMFORT_QUESTION, WORST_ZONES_QUESTION, BAND_F, WATCH_PERCENT, ACTION_PERCENT, ACTION_DEVIATION_F } from "./comfort";
export { manualOverrides, OVERRIDES_QUESTION, OVERRIDE_ROLES } from "./overrides";
export { runOutsideSchedule, SCHEDULES_QUESTION, STATUS_ROLES, ACTION_HOURS } from "./schedules";
