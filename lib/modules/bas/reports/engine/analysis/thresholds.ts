import { MINUTE_MS } from "../series";

/**
 * The numbers questions 6-18 judge by (Reports, Phase 5).
 *
 * Two kinds, kept apart on purpose:
 *
 *   SPEC   - the number is in the library text (Jim's "BAS Health Report:
 *            Build Spec", 27 October 2026), and is used exactly as written.
 *            Changing one of these changes the question, not a tuning.
 *   CHOSEN - the spec leaves the number open, so one was picked. Each says
 *            why, and each is listed in CHOSEN_THRESHOLDS below, which is
 *            what runbook.md (*Reports: a VAV, air handler, plant or DX
 *            finding looks wrong*) prints and what a test holds to this
 *            file.
 *
 * The persistence rule that gates every finding - 30 minutes at a stretch
 * during the hours that count, or recurring on two or more days - is the
 * spec's and lives in series.ts (`persistence`), shared with Phase 2.
 *
 * Priority. Every question raises Watch the moment the persistence rule is
 * met, because that is the spec's bar for a finding at all. What makes one
 * Action Needed is CHOSEN per question, from the spec's own words for the
 * status ("comfort complaint likely, equipment at risk, safety tripped, or
 * major energy waste"), and is listed below with the rest.
 */

// ---------------------------------------------------------------- shared

/**
 * CHOSEN. A valve or damper command above this many percent is "open". A
 * command of 1-2% is controller noise or a valve held just off its seat,
 * and a valve at 3% passes almost no water; 5% is the smallest command
 * that reliably means the loop is asking for something.
 */
export const VALVE_OPEN_PCT = 5;

/**
 * CHOSEN. The share of judged time out of tolerance at which a comfort- or
 * control-quality finding becomes Action Needed: half the hours. The same
 * figure Space Comfort has used since Phase 2 (comfort.ts ACTION_PERCENT),
 * so "Action Needed" means one thing across the report.
 */
export const ACTION_SHARE_PERCENT = 50;

/**
 * CHOSEN. For the energy-waste questions (heating and cooling together,
 * reheat against cooling, the economizer shut while compressors run), the
 * hours in the period at which waste is "major": eight hours is one working
 * day's worth in a week of the fault. Q19 (Phase 2) uses twenty for a fan
 * running to an empty building; fighting heat against cooling burns both
 * and earns the lower bar.
 */
export const ENERGY_ACTION_HOURS = 8;

// ---------------------------------------------------------------- VAV

/** SPEC (Q6). "Below 80% of airflow setpoint." */
export const AIRFLOW_FRACTION = 0.8;

/**
 * CHOSEN (Q7). "100% damper": a command at or above 95%. Controllers clamp
 * at 98 or 99 as often as at 100, and a box at 96% has nothing left to give
 * either.
 */
export const DAMPER_FULL_PCT = 95;

/**
 * CHOSEN (Q7). "Missed setpoint": outside ±2 °F of it, the band Q3 uses -
 * the spec's own comfort tolerance - so a zone Q3 calls in band Q7 never
 * calls missed.
 */
export const MISSED_SETPOINT_F = 2;

/**
 * CHOSEN (Q8). "Above cooling setpoint": by more than 1 °F. A few tenths
 * over is the sensor's own resolution and a thermostat's deadband; a reheat
 * valve open while the room is a full degree over the cooling setpoint is
 * heating a room that is asking for cooling.
 */
export const ABOVE_COOLING_MARGIN_F = 1;

// ---------------------------------------------------------------- AHU / RTU

/** SPEC (Q9). "±1.5°F on modulating valves." */
export const DAT_BAND_MODULATING_F = 1.5;
/** SPEC (Q9). "±4°F on staged DX." */
export const DAT_BAND_STAGED_F = 4;

/**
 * CHOSEN (Q9, Q10). After the supply fan starts, its first 15 minutes are
 * not judged: discharge air and duct static take that long to settle from
 * a cold start, and every unit misses for the first ten minutes of every
 * morning. Without it the spec's "two or more days" rule would turn a
 * normal start-up into a recurring finding on every unit.
 */
export const FAN_SETTLE_MS = 15 * MINUTE_MS;

/**
 * CHOSEN (Q10). "Track setpoint": within ±0.1 in. w.c., or 10% of the
 * setpoint when that is larger. 0.1 in. w.c. is the usual commissioning
 * tolerance on a duct static loop; the percentage keeps a 3 in. w.c. system
 * from being judged on a band meant for a 1 in. one.
 */
export const STATIC_BAND_INWC = 0.1;
export const STATIC_BAND_FRACTION = 0.1;
/** 1 in. w.c. in pascals, for a static point trended in Pa. A conversion, not a choice. */
export const PA_PER_INWC = 249.0889;

/**
 * CHOSEN (Q12, Q17). "Economizer at minimum": the outside air damper at or
 * below 20%. Minimum outside air positions run 10-20%; at or under the top
 * of that range a damper is ventilating, not economizing.
 */
export const ECON_MIN_POSITION_PCT = 20;

/**
 * CHOSEN (Q12). "Free cooling available": outdoor air at least 5 °F cooler
 * than return air (a differential dry-bulb economizer's enable, with a margin
 * for sensor error), and not above 65 °F - the fixed dry-bulb high limit
 * ASHRAE 90.1 gives a humid climate (zone 4A, Cincinnati), above which a
 * correctly set economizer locks out on purpose. Judged only while the unit
 * runs, is not heating, and is calling for mechanical cooling: without a
 * call for cooling, an economizer at minimum in its deadband is correct, and
 * the spec's "a false alarm costs a truck roll" decides that a unit with no
 * cooling point trended is not judged rather than guessed at.
 */
export const ECON_DIFFERENTIAL_F = 5;
export const ECON_HIGH_LIMIT_F = 65;

// ---------------------------------------------------------------- hydronic

/** SPEC (Q13). "Delta T at least 10°F." */
export const HW_MIN_DELTA_T_F = 10;
/** SPEC (Q14). "Delta T at least 8°F." */
export const CHW_MIN_DELTA_T_F = 8;

/**
 * CHOSEN (Q13). "Hold setpoint or reset": within ±4 °F of the HWS setpoint
 * point, which carries the reset value where the controller resets it. A
 * boiler plant stages its burners and swings a few degrees doing it; four
 * clears that and still catches a plant that cannot make temperature.
 */
export const HWS_BAND_F = 4;

/**
 * CHOSEN (Q14). "Hold setpoint": within ±2 °F of the CHWS setpoint. A
 * chiller holds leaving water to a degree or so; two allows for staging.
 */
export const CHWS_BAND_F = 2;

/**
 * CHOSEN (Q13, Q14). When the plant is judged. A boiler, chiller or pump
 * status on the plant, when one is trended; otherwise the loop is taken to
 * be in service while supply and return differ by at least 2 °F, which is
 * water moving through a running plant. A plant switched off for the
 * season holds supply and return within a degree of each other, and is not
 * judged against a setpoint it is not trying to meet.
 */
export const LOOP_IN_SERVICE_DELTA_F = 2;

// ---------------------------------------------------------------- DX

/** SPEC (Q15). "More than 4 starts per hour on any stage." */
export const MAX_STARTS_PER_HOUR = 4;
/** SPEC (Q15). The hour the starts are counted in, as a sliding window. */
export const STARTS_WINDOW_MS = 60 * MINUTE_MS;

/**
 * CHOSEN (Q15). A compressor trend coarser than five minutes cannot show
 * five starts in an hour - a start needs an off reading and an on reading -
 * so it is not judged, and the report says why. Change-of-value trends,
 * which log every start, are always judged.
 */
export const SHORT_CYCLE_MAX_INTERVAL_S = 300;

/**
 * CHOSEN (Q15). Short cycling that recurs on two or more days is Action
 * Needed - "equipment at risk", in the spec's words for the status, since
 * every start wears a compressor - and one day of it is Watch: a single bad
 * afternoon can be a staging test or a mild day's light load.
 */
export const SHORT_CYCLE_ACTION_DAYS = 2;

/** SPEC (Q16). "With compressors running 15 minutes or more." */
export const COMPRESSOR_SETTLE_MS = 15 * MINUTE_MS;
/** SPEC (Q16). "Did DAT drop at least 15°F below return or mixed air?" */
export const DX_MIN_DROP_F = 15;
/** SPEC (Q16). "Under 10°F points to low charge, a failed compressor, or a dirty coil" - Action Needed. */
export const DX_FAULT_DROP_F = 10;

/** SPEC (Q17). "While OAT was below 55°F." */
export const ECON_OAT_F = 55;

/** SPEC (Q18). "With heat stages on 10 minutes or more." */
export const HEAT_SETTLE_MS = 10 * MINUTE_MS;
/** SPEC (Q18). "Did DAT rise at least 20°F above return or mixed air?" */
export const HEAT_MIN_RISE_F = 20;
/**
 * CHOSEN (Q18). A rise under 10 °F - half the spec's 20 - is Action Needed:
 * the stages are on and barely warming the air, a failed stage or burner.
 * The spec names a fault floor for cooling (Q16) and none for heat; this
 * mirrors Q16's.
 */
export const HEAT_FAULT_RISE_F = 10;

/**
 * Every CHOSEN number above, in words, in one list: what the PR and the
 * runbook print, and what tests/bas-reports-phase5.test.ts holds to the
 * constants so the list cannot drift from the code.
 */
export const CHOSEN_THRESHOLDS: ReadonlyArray<{ questions: string; name: string; value: number; unit: string; why: string }> = [
  { questions: "Q8, Q11, Q12", name: "VALVE_OPEN_PCT", value: VALVE_OPEN_PCT, unit: "%", why: "a valve command above this is open" },
  { questions: "Q6, Q7, Q9, Q10, Q13, Q14", name: "ACTION_SHARE_PERCENT", value: ACTION_SHARE_PERCENT, unit: "% of judged time", why: "out of tolerance this much of the time is Action Needed (as Space Comfort)" },
  { questions: "Q8, Q11, Q12, Q17", name: "ENERGY_ACTION_HOURS", value: ENERGY_ACTION_HOURS, unit: "h in the period", why: "energy waste this long is major, Action Needed" },
  { questions: "Q7", name: "DAMPER_FULL_PCT", value: DAMPER_FULL_PCT, unit: "%", why: "\"100% damper\" is a command at or above this" },
  { questions: "Q7", name: "MISSED_SETPOINT_F", value: MISSED_SETPOINT_F, unit: "°F", why: "\"missed setpoint\" is outside this band, Q3's" },
  { questions: "Q8", name: "ABOVE_COOLING_MARGIN_F", value: ABOVE_COOLING_MARGIN_F, unit: "°F", why: "\"above cooling setpoint\" is by more than this" },
  { questions: "Q9, Q10", name: "FAN_SETTLE_MS", value: FAN_SETTLE_MS / MINUTE_MS, unit: "min", why: "not judged for this long after the supply fan starts" },
  { questions: "Q10", name: "STATIC_BAND_INWC", value: STATIC_BAND_INWC, unit: "in. w.c.", why: "duct static tolerance, or STATIC_BAND_FRACTION of setpoint if larger" },
  { questions: "Q10", name: "STATIC_BAND_FRACTION", value: STATIC_BAND_FRACTION * 100, unit: "% of setpoint", why: "duct static tolerance on a high-static system" },
  { questions: "Q12, Q17", name: "ECON_MIN_POSITION_PCT", value: ECON_MIN_POSITION_PCT, unit: "%", why: "an OA damper at or below this is at minimum" },
  { questions: "Q12", name: "ECON_DIFFERENTIAL_F", value: ECON_DIFFERENTIAL_F, unit: "°F", why: "free cooling needs OAT this far below RAT" },
  { questions: "Q12", name: "ECON_HIGH_LIMIT_F", value: ECON_HIGH_LIMIT_F, unit: "°F", why: "no free cooling above this OAT (90.1 high limit, zone 4A)" },
  { questions: "Q13", name: "HWS_BAND_F", value: HWS_BAND_F, unit: "°F", why: "HWS holds setpoint within this" },
  { questions: "Q14", name: "CHWS_BAND_F", value: CHWS_BAND_F, unit: "°F", why: "CHWS holds setpoint within this" },
  { questions: "Q13, Q14", name: "LOOP_IN_SERVICE_DELTA_F", value: LOOP_IN_SERVICE_DELTA_F, unit: "°F", why: "with no plant status trended, a loop is in service while supply and return differ by this" },
  { questions: "Q15", name: "SHORT_CYCLE_MAX_INTERVAL_S", value: SHORT_CYCLE_MAX_INTERVAL_S, unit: "s", why: "a compressor trend coarser than this cannot show five starts an hour, and is not judged" },
  { questions: "Q15", name: "SHORT_CYCLE_ACTION_DAYS", value: SHORT_CYCLE_ACTION_DAYS, unit: "days", why: "short cycling on this many days is Action Needed; one day is Watch" },
  { questions: "Q18", name: "HEAT_FAULT_RISE_F", value: HEAT_FAULT_RISE_F, unit: "°F", why: "an average rise under this is Action Needed" },
];
