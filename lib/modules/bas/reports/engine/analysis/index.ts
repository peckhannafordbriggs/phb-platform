import { economizerAtMinimum, datHoldsSetpoint, simultaneousHeatingCooling, staticTracksSetpoint } from "./air-handlers";
import type { QuestionFn } from "./common";
import { compressorShortCycling, compressorsDuringEconomizer, dxCoolingDelta, heatStageDelta } from "./dx";
import { chilledWaterLoop, hotWaterLoop } from "./hydronic";
import { reheatOpenAboveCoolingSetpoint, vavDamperFullMissedSetpoint, vavStarvedAirflow } from "./vav";

/**
 * Which library question has an analysis function, and how it is answered.
 *
 * `analysis_fn` on a library row is the key here. Every one of the twenty is
 * built since Phase 5 (2026-11-16): `built` is a function over the units the
 * inventory qualified, `derived` is answered from the other questions'
 * results (the two Summary questions). `not_built` stays a value because a
 * library row the code does not know - an admin-added planner question, a
 * key from a later phase - must still be decided rather than dropped, and
 * documents stored before Phase 5 carry questions that read "not built".
 */
export type AnalysisAvailability = "built" | "derived" | "not_built";

export const ANALYSIS_AVAILABILITY: Readonly<Record<string, AnalysisAvailability>> = {
  q01_building_status: "derived",
  q02_changes_since_last: "derived",
  q03_zone_comfort: "built",
  q04_worst_zones: "built",
  q05_manual_overrides: "built",
  q06_vav_starved_airflow: "built",
  q07_vav_damper_full_missed_setpoint: "built",
  q08_reheat_open_above_cooling_sp: "built",
  q09_dat_holds_setpoint: "built",
  q10_static_tracks_setpoint: "built",
  q11_simultaneous_heating_cooling: "built",
  q12_economizer_at_minimum: "built",
  q13_hw_supply_and_delta_t: "built",
  q14_chw_supply_and_delta_t: "built",
  q15_compressor_short_cycling: "built",
  q16_dx_cooling_delta: "built",
  q17_compressors_during_economizer: "built",
  q18_heat_stage_delta: "built",
  q19_run_outside_schedule: "built",
  q20_data_health: "built",
};

/**
 * Questions 6-18 (Phase 5): one function each, all the same shape - the
 * qualified units in, findings, skipped units and the headline metrics out.
 * run.ts dispatches through this table; the five Phase 2 questions keep
 * their own branches because their shapes predate it.
 */
export const EQUIPMENT_QUESTIONS: Readonly<Record<string, QuestionFn>> = {
  q06_vav_starved_airflow: vavStarvedAirflow,
  q07_vav_damper_full_missed_setpoint: vavDamperFullMissedSetpoint,
  q08_reheat_open_above_cooling_sp: reheatOpenAboveCoolingSetpoint,
  q09_dat_holds_setpoint: datHoldsSetpoint,
  q10_static_tracks_setpoint: staticTracksSetpoint,
  q11_simultaneous_heating_cooling: simultaneousHeatingCooling,
  q12_economizer_at_minimum: economizerAtMinimum,
  q13_hw_supply_and_delta_t: hotWaterLoop,
  q14_chw_supply_and_delta_t: chilledWaterLoop,
  q15_compressor_short_cycling: compressorShortCycling,
  q16_dx_cooling_delta: dxCoolingDelta,
  q17_compressors_during_economizer: compressorsDuringEconomizer,
  q18_heat_stage_delta: heatStageDelta,
};

/** The reason a question reads when it could have run and the code has no function for it. Phase 2-4 documents carry it. */
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
export type { AnalysisContext, QuestionAnalysis, QuestionFn } from "./common";
export { CHOSEN_THRESHOLDS } from "./thresholds";
export { datBand, staticTolerance } from "./air-handlers";
export { cannotCountStarts, slidingStarts, stageStarts } from "./dx";
export {
  vavStarvedAirflow,
  vavDamperFullMissedSetpoint,
  reheatOpenAboveCoolingSetpoint,
  datHoldsSetpoint,
  staticTracksSetpoint,
  simultaneousHeatingCooling,
  economizerAtMinimum,
  hotWaterLoop,
  chilledWaterLoop,
  compressorShortCycling,
  dxCoolingDelta,
  compressorsDuringEconomizer,
  heatStageDelta,
};
