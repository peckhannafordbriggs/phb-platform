// Relative, not "@/...": prisma/seed.ts runs under tsx, and scripts/db.ts imports
// the generated client the same way for the same reason.
import type { Prisma, PrismaClient } from "../lib/generated/prisma/client";

/**
 * The BAS semantic vocabularies: equipment types and point roles.
 *
 * Reference data, so it lives with the seed alongside positions and departments
 * - see docs/05-database-and-sources.md. It used to live nowhere: these rows
 * reached the development database only because scripts/bas-import.ts copied
 * them out of the standalone `bas` database, so a fresh database came up with an
 * EMPTY vocabulary and nothing said so. Every point read as unclassified, which
 * is indistinguishable from a building nobody has labelled yet, and both pairing
 * views returned zero rows.
 *
 * Ported verbatim from C:\dev\bas-db\migrations\002_vocabularies.sql, which
 * remains the prose source. Coverage is standard commercial HVAC.
 *
 * point_role is the highest-leverage field in the schema. Without it, "what was
 * the supply air temperature on AHU-3" needs to know that this building's
 * integrator called it AHU3_SAT while the building next door calls it
 * AHU-3/SupplyTemp. With it, that is `WHERE point_role = 'supply_air_temp'` and
 * it works everywhere.
 *
 * A role is added HERE, deliberately, not as an ad-hoc string at ingest time.
 */

type DbClient = PrismaClient | Prisma.TransactionClient;

export interface BasEquipmentTypeSeed {
  equipType: string;
  displayName: string;
  description: string;
  /** Coarse grouping: air_side, water_side, plant, terminal, metering, other. */
  category: string;
}

export interface BasPointRoleSeed {
  pointRole: string;
  displayName: string;
  description: string;
  /** Physical quantity. Null for non-physical roles. */
  measurement: string | null;
  typicalUnit: string | null;
  isSetpoint?: boolean;
  isCommand?: boolean;
  isStatus?: boolean;
  /**
   * The measurement this setpoint governs. On 'supply_air_temp_sp' this is
   * 'supply_air_temp', which is what makes "which units never reached setpoint"
   * answerable across every building without hardcoding point pairs.
   */
  setpointFor?: string;
  /**
   * The command this status proves. On 'supply_fan_status' this is
   * 'supply_fan_cmd'. Commanded on while its status is off is a fault - real,
   * common, and expensive.
   */
  statusOf?: string;
}

/** Lets "compare all AHUs" work without string-matching on names. */
export const BAS_EQUIPMENT_TYPES: BasEquipmentTypeSeed[] = [
  {
    equipType: "ahu",
    displayName: "Air Handling Unit",
    description:
      "Conditions and distributes air to a zone, floor, or building section.",
    category: "air_side",
  },
  {
    equipType: "rtu",
    displayName: "Rooftop Unit",
    description:
      "Packaged rooftop air handler with integral heating and cooling.",
    category: "air_side",
  },
  {
    equipType: "doas",
    displayName: "Dedicated Outdoor Air System",
    description:
      "Conditions outside air only, typically feeding terminal units.",
    category: "air_side",
  },
  {
    equipType: "vav",
    displayName: "VAV Box",
    description: "Variable air volume terminal regulating airflow into a zone.",
    category: "terminal",
  },
  {
    equipType: "cav",
    displayName: "CAV Box",
    description: "Constant air volume terminal.",
    category: "terminal",
  },
  {
    equipType: "fcu",
    displayName: "Fan Coil Unit",
    description: "Local fan with a coil serving a single space.",
    category: "terminal",
  },
  {
    equipType: "unit_heater",
    displayName: "Unit Heater",
    description: "Local heating-only terminal.",
    category: "terminal",
  },
  {
    equipType: "vrf_indoor",
    displayName: "VRF Indoor Unit",
    description: "Variable refrigerant flow indoor terminal.",
    category: "terminal",
  },
  {
    equipType: "vrf_outdoor",
    displayName: "VRF Outdoor Unit",
    description: "Variable refrigerant flow condensing unit.",
    category: "plant",
  },
  {
    equipType: "split_system",
    displayName: "Split System",
    description: "Split DX system with separate indoor and outdoor sections.",
    category: "air_side",
  },
  {
    equipType: "crac",
    displayName: "CRAC / CRAH Unit",
    description: "Computer room air conditioning or air handling unit.",
    category: "air_side",
  },
  {
    equipType: "chiller",
    displayName: "Chiller",
    description: "Produces chilled water for cooling.",
    category: "plant",
  },
  {
    equipType: "boiler",
    displayName: "Boiler",
    description: "Produces hot water or steam for heating.",
    category: "plant",
  },
  {
    equipType: "cooling_tower",
    displayName: "Cooling Tower",
    description: "Rejects condenser heat to atmosphere.",
    category: "plant",
  },
  {
    equipType: "pump",
    displayName: "Pump",
    description: "Circulates chilled, hot, or condenser water.",
    category: "water_side",
  },
  {
    equipType: "heat_exchanger",
    displayName: "Heat Exchanger",
    description: "Transfers heat between two fluid loops.",
    category: "water_side",
  },
  {
    equipType: "exhaust_fan",
    displayName: "Exhaust Fan",
    description: "Removes air from a space or system.",
    category: "air_side",
  },
  {
    equipType: "plant_chw",
    displayName: "Chilled Water Plant",
    description:
      "The chilled water system as a whole: chillers, pumps, headers.",
    category: "plant",
  },
  {
    equipType: "plant_hw",
    displayName: "Hot Water Plant",
    description: "The hot water system as a whole: boilers, pumps, headers.",
    category: "plant",
  },
  {
    equipType: "zone",
    displayName: "Zone",
    description: "A conditioned space. Not equipment, but points attach to it.",
    category: "other",
  },
  {
    equipType: "meter_electric",
    displayName: "Electric Meter",
    description: "Measures electrical power or energy.",
    category: "metering",
  },
  {
    equipType: "meter_gas",
    displayName: "Gas Meter",
    description: "Measures natural gas flow or volume.",
    category: "metering",
  },
  {
    equipType: "meter_water",
    displayName: "Water Meter",
    description: "Measures water flow or volume.",
    category: "metering",
  },
  {
    equipType: "weather",
    displayName: "Weather Station",
    description: "Outdoor conditions sensor package.",
    category: "other",
  },
  {
    equipType: "other",
    displayName: "Other",
    description: "Anything not otherwise classified.",
    category: "other",
  },
];

/**
 * What KIND of measurement a point is. A table rather than an enum,
 * deliberately: an analyst - or a language model writing SQL - can SELECT from
 * it to discover what values exist and what they mean. An enum is invisible
 * from inside a query.
 */
export const BAS_POINT_ROLES: BasPointRoleSeed[] = [
  // Air temperatures ----------------------------------------------------------
  {
    pointRole: "supply_air_temp",
    displayName: "Supply Air Temperature",
    description:
      "Air temperature leaving the unit into the distribution system.",
    measurement: "temperature",
    typicalUnit: "degF",
  },
  {
    pointRole: "supply_air_temp_sp",
    displayName: "Supply Air Temperature Setpoint",
    description: "Target supply air temperature.",
    measurement: "temperature",
    typicalUnit: "degF",
    isSetpoint: true,
    setpointFor: "supply_air_temp",
  },
  {
    pointRole: "return_air_temp",
    displayName: "Return Air Temperature",
    description: "Air temperature returning from the space.",
    measurement: "temperature",
    typicalUnit: "degF",
  },
  {
    pointRole: "mixed_air_temp",
    displayName: "Mixed Air Temperature",
    description:
      "Air temperature after outside and return air mix, before coils.",
    measurement: "temperature",
    typicalUnit: "degF",
  },
  {
    pointRole: "discharge_air_temp",
    displayName: "Discharge Air Temperature",
    description: "Air temperature leaving a terminal unit into the zone.",
    measurement: "temperature",
    typicalUnit: "degF",
  },
  {
    pointRole: "discharge_air_temp_sp",
    displayName: "Discharge Air Temperature Setpoint",
    description: "Target discharge air temperature.",
    measurement: "temperature",
    typicalUnit: "degF",
    isSetpoint: true,
    setpointFor: "discharge_air_temp",
  },
  {
    pointRole: "outside_air_temp",
    displayName: "Outside Air Temperature",
    description: "Ambient outdoor dry bulb temperature.",
    measurement: "temperature",
    typicalUnit: "degF",
  },
  {
    pointRole: "preheat_air_temp",
    displayName: "Preheat Air Temperature",
    description: "Air temperature after a preheat coil.",
    measurement: "temperature",
    typicalUnit: "degF",
  },
  // Zone conditions -----------------------------------------------------------
  {
    pointRole: "zone_temp",
    displayName: "Zone Temperature",
    description: "Measured space temperature.",
    measurement: "temperature",
    typicalUnit: "degF",
  },
  {
    pointRole: "zone_temp_sp",
    displayName: "Zone Temperature Setpoint",
    description: "Target space temperature (single setpoint).",
    measurement: "temperature",
    typicalUnit: "degF",
    isSetpoint: true,
    setpointFor: "zone_temp",
  },
  {
    pointRole: "zone_temp_cooling_sp",
    displayName: "Zone Cooling Setpoint",
    description: "Space temperature above which cooling is called.",
    measurement: "temperature",
    typicalUnit: "degF",
    isSetpoint: true,
    setpointFor: "zone_temp",
  },
  {
    pointRole: "zone_temp_heating_sp",
    displayName: "Zone Heating Setpoint",
    description: "Space temperature below which heating is called.",
    measurement: "temperature",
    typicalUnit: "degF",
    isSetpoint: true,
    setpointFor: "zone_temp",
  },
  {
    pointRole: "space_humidity",
    displayName: "Space Relative Humidity",
    description: "Measured relative humidity in the space.",
    measurement: "humidity",
    typicalUnit: "percent",
  },
  {
    pointRole: "space_humidity_sp",
    displayName: "Space Humidity Setpoint",
    description: "Target relative humidity.",
    measurement: "humidity",
    typicalUnit: "percent",
    isSetpoint: true,
    setpointFor: "space_humidity",
  },
  {
    pointRole: "return_air_humidity",
    displayName: "Return Air Humidity",
    description: "Relative humidity of return air.",
    measurement: "humidity",
    typicalUnit: "percent",
  },
  {
    pointRole: "outside_air_humidity",
    displayName: "Outside Air Humidity",
    description: "Ambient outdoor relative humidity.",
    measurement: "humidity",
    typicalUnit: "percent",
  },
  {
    pointRole: "dewpoint",
    displayName: "Dewpoint Temperature",
    description: "Dewpoint, measured or calculated.",
    measurement: "temperature",
    typicalUnit: "degF",
  },
  {
    pointRole: "space_co2",
    displayName: "Space CO2",
    description:
      "Carbon dioxide concentration, a proxy for occupancy and ventilation " +
      "adequacy.",
    measurement: "concentration",
    typicalUnit: "ppm",
  },
  {
    pointRole: "space_co2_sp",
    displayName: "Space CO2 Setpoint",
    description: "CO2 level above which ventilation increases.",
    measurement: "concentration",
    typicalUnit: "ppm",
    isSetpoint: true,
    setpointFor: "space_co2",
  },
  // Water temperatures --------------------------------------------------------
  {
    pointRole: "chw_supply_temp",
    displayName: "Chilled Water Supply Temperature",
    description: "Chilled water leaving the plant.",
    measurement: "temperature",
    typicalUnit: "degF",
  },
  {
    pointRole: "chw_supply_temp_sp",
    displayName: "Chilled Water Supply Setpoint",
    description: "Target chilled water supply temperature.",
    measurement: "temperature",
    typicalUnit: "degF",
    isSetpoint: true,
    setpointFor: "chw_supply_temp",
  },
  {
    pointRole: "chw_return_temp",
    displayName: "Chilled Water Return Temperature",
    description: "Chilled water returning to the plant.",
    measurement: "temperature",
    typicalUnit: "degF",
  },
  {
    pointRole: "hw_supply_temp",
    displayName: "Hot Water Supply Temperature",
    description: "Hot water leaving the plant.",
    measurement: "temperature",
    typicalUnit: "degF",
  },
  {
    pointRole: "hw_supply_temp_sp",
    displayName: "Hot Water Supply Setpoint",
    description: "Target hot water supply temperature.",
    measurement: "temperature",
    typicalUnit: "degF",
    isSetpoint: true,
    setpointFor: "hw_supply_temp",
  },
  {
    pointRole: "hw_return_temp",
    displayName: "Hot Water Return Temperature",
    description: "Hot water returning to the plant.",
    measurement: "temperature",
    typicalUnit: "degF",
  },
  {
    pointRole: "cw_supply_temp",
    displayName: "Condenser Water Supply Temperature",
    description: "Condenser water leaving the tower.",
    measurement: "temperature",
    typicalUnit: "degF",
  },
  {
    pointRole: "cw_return_temp",
    displayName: "Condenser Water Return Temperature",
    description: "Condenser water returning to the tower.",
    measurement: "temperature",
    typicalUnit: "degF",
  },
  // Pressure ------------------------------------------------------------------
  {
    pointRole: "duct_static_pressure",
    displayName: "Duct Static Pressure",
    description:
      "Static pressure in the supply duct, the primary VAV fan control input.",
    measurement: "pressure",
    typicalUnit: "inH2O",
  },
  {
    pointRole: "duct_static_pressure_sp",
    displayName: "Duct Static Pressure Setpoint",
    description: "Target duct static pressure.",
    measurement: "pressure",
    typicalUnit: "inH2O",
    isSetpoint: true,
    setpointFor: "duct_static_pressure",
  },
  {
    pointRole: "building_static_pressure",
    displayName: "Building Static Pressure",
    description: "Pressure of the building relative to outside.",
    measurement: "pressure",
    typicalUnit: "inH2O",
  },
  {
    pointRole: "filter_dp",
    displayName: "Filter Differential Pressure",
    description:
      "Pressure drop across a filter bank. Rises as the filter loads.",
    measurement: "pressure",
    typicalUnit: "inH2O",
  },
  {
    pointRole: "water_dp",
    displayName: "Water Differential Pressure",
    description: "Differential pressure across a water loop.",
    measurement: "pressure",
    typicalUnit: "psi",
  },
  {
    pointRole: "suction_pressure",
    displayName: "Suction Pressure",
    description: "Refrigerant suction pressure.",
    measurement: "pressure",
    typicalUnit: "psi",
  },
  {
    pointRole: "discharge_pressure",
    displayName: "Discharge Pressure",
    description: "Refrigerant discharge pressure.",
    measurement: "pressure",
    typicalUnit: "psi",
  },
  // Flow ----------------------------------------------------------------------
  {
    pointRole: "supply_air_flow",
    displayName: "Supply Air Flow",
    description: "Volumetric airflow supplied.",
    measurement: "flow",
    typicalUnit: "cfm",
  },
  {
    pointRole: "supply_air_flow_sp",
    displayName: "Supply Air Flow Setpoint",
    description: "Target supply airflow.",
    measurement: "flow",
    typicalUnit: "cfm",
    isSetpoint: true,
    setpointFor: "supply_air_flow",
  },
  {
    pointRole: "outside_air_flow",
    displayName: "Outside Air Flow",
    description:
      "Volumetric outside air intake. Key to ventilation compliance.",
    measurement: "flow",
    typicalUnit: "cfm",
  },
  {
    pointRole: "outside_air_flow_sp",
    displayName: "Outside Air Flow Setpoint",
    description: "Target outside airflow.",
    measurement: "flow",
    typicalUnit: "cfm",
    isSetpoint: true,
    setpointFor: "outside_air_flow",
  },
  {
    pointRole: "exhaust_air_flow",
    displayName: "Exhaust Air Flow",
    description: "Volumetric exhaust airflow.",
    measurement: "flow",
    typicalUnit: "cfm",
  },
  {
    pointRole: "chw_flow",
    displayName: "Chilled Water Flow",
    description: "Chilled water volumetric flow.",
    measurement: "flow",
    typicalUnit: "gpm",
  },
  {
    pointRole: "hw_flow",
    displayName: "Hot Water Flow",
    description: "Hot water volumetric flow.",
    measurement: "flow",
    typicalUnit: "gpm",
  },
  // Valve and damper positions ------------------------------------------------
  {
    pointRole: "cooling_valve_cmd",
    displayName: "Cooling Valve Command",
    description: "Commanded position of the chilled water or DX cooling valve.",
    measurement: "position",
    typicalUnit: "percent",
    isCommand: true,
  },
  {
    pointRole: "heating_valve_cmd",
    displayName: "Heating Valve Command",
    description: "Commanded position of the heating valve.",
    measurement: "position",
    typicalUnit: "percent",
    isCommand: true,
  },
  {
    pointRole: "reheat_valve_cmd",
    displayName: "Reheat Valve Command",
    description: "Commanded position of a terminal reheat valve.",
    measurement: "position",
    typicalUnit: "percent",
    isCommand: true,
  },
  {
    pointRole: "oa_damper_cmd",
    displayName: "Outside Air Damper Command",
    description:
      "Commanded outside air damper position. The economizer output.",
    measurement: "position",
    typicalUnit: "percent",
    isCommand: true,
  },
  {
    pointRole: "ra_damper_cmd",
    displayName: "Return Air Damper Command",
    description: "Commanded return air damper position.",
    measurement: "position",
    typicalUnit: "percent",
    isCommand: true,
  },
  {
    pointRole: "ea_damper_cmd",
    displayName: "Exhaust Air Damper Command",
    description: "Commanded exhaust/relief damper position.",
    measurement: "position",
    typicalUnit: "percent",
    isCommand: true,
  },
  {
    pointRole: "vav_damper_cmd",
    displayName: "VAV Damper Command",
    description: "Commanded terminal box damper position.",
    measurement: "position",
    typicalUnit: "percent",
    isCommand: true,
  },
  {
    pointRole: "bypass_damper_cmd",
    displayName: "Bypass Damper Command",
    description: "Commanded bypass damper position.",
    measurement: "position",
    typicalUnit: "percent",
    isCommand: true,
  },
  // Fans ----------------------------------------------------------------------
  {
    pointRole: "supply_fan_cmd",
    displayName: "Supply Fan Command",
    description: "Start/stop command to the supply fan.",
    measurement: "status",
    typicalUnit: null,
    isCommand: true,
  },
  {
    pointRole: "supply_fan_status",
    displayName: "Supply Fan Status",
    description: "Proven running feedback for the supply fan.",
    measurement: "status",
    typicalUnit: null,
    isStatus: true,
    statusOf: "supply_fan_cmd",
  },
  {
    pointRole: "supply_fan_speed",
    displayName: "Supply Fan Speed",
    description: "Supply fan VFD speed.",
    measurement: "speed",
    typicalUnit: "percent",
    isCommand: true,
  },
  {
    pointRole: "return_fan_cmd",
    displayName: "Return Fan Command",
    description: "Start/stop command to the return fan.",
    measurement: "status",
    typicalUnit: null,
    isCommand: true,
  },
  {
    pointRole: "return_fan_status",
    displayName: "Return Fan Status",
    description: "Proven running feedback for the return fan.",
    measurement: "status",
    typicalUnit: null,
    isStatus: true,
    statusOf: "return_fan_cmd",
  },
  {
    pointRole: "return_fan_speed",
    displayName: "Return Fan Speed",
    description: "Return fan VFD speed.",
    measurement: "speed",
    typicalUnit: "percent",
    isCommand: true,
  },
  {
    pointRole: "exhaust_fan_cmd",
    displayName: "Exhaust Fan Command",
    description: "Start/stop command to an exhaust fan.",
    measurement: "status",
    typicalUnit: null,
    isCommand: true,
  },
  {
    pointRole: "exhaust_fan_status",
    displayName: "Exhaust Fan Status",
    description: "Proven running feedback for an exhaust fan.",
    measurement: "status",
    typicalUnit: null,
    isStatus: true,
    statusOf: "exhaust_fan_cmd",
  },
  // Pumps and plant -----------------------------------------------------------
  {
    pointRole: "pump_cmd",
    displayName: "Pump Command",
    description: "Start/stop command to a pump.",
    measurement: "status",
    typicalUnit: null,
    isCommand: true,
  },
  {
    pointRole: "pump_status",
    displayName: "Pump Status",
    description: "Proven running feedback for a pump.",
    measurement: "status",
    typicalUnit: null,
    isStatus: true,
    statusOf: "pump_cmd",
  },
  {
    pointRole: "pump_speed",
    displayName: "Pump Speed",
    description: "Pump VFD speed.",
    measurement: "speed",
    typicalUnit: "percent",
    isCommand: true,
  },
  {
    pointRole: "chiller_cmd",
    displayName: "Chiller Command",
    description: "Enable command to a chiller.",
    measurement: "status",
    typicalUnit: null,
    isCommand: true,
  },
  {
    pointRole: "chiller_status",
    displayName: "Chiller Status",
    description: "Running feedback from a chiller.",
    measurement: "status",
    typicalUnit: null,
    isStatus: true,
    statusOf: "chiller_cmd",
  },
  {
    pointRole: "boiler_cmd",
    displayName: "Boiler Command",
    description: "Enable command to a boiler.",
    measurement: "status",
    typicalUnit: null,
    isCommand: true,
  },
  {
    pointRole: "boiler_status",
    displayName: "Boiler Status",
    description: "Running feedback from a boiler.",
    measurement: "status",
    typicalUnit: null,
    isStatus: true,
    statusOf: "boiler_cmd",
  },
  {
    pointRole: "compressor_cmd",
    displayName: "Compressor Command",
    description: "Enable command to a compressor.",
    measurement: "status",
    typicalUnit: null,
    isCommand: true,
  },
  {
    pointRole: "compressor_status",
    displayName: "Compressor Status",
    description: "Running feedback from a compressor.",
    measurement: "status",
    typicalUnit: null,
    isStatus: true,
    statusOf: "compressor_cmd",
  },
  {
    pointRole: "tower_fan_cmd",
    displayName: "Cooling Tower Fan Command",
    description: "Start/stop command to a cooling tower fan.",
    measurement: "status",
    typicalUnit: null,
    isCommand: true,
  },
  {
    pointRole: "tower_fan_status",
    displayName: "Cooling Tower Fan Status",
    description: "Proven running feedback for a cooling tower fan.",
    measurement: "status",
    typicalUnit: null,
    isStatus: true,
    statusOf: "tower_fan_cmd",
  },
  {
    pointRole: "cooling_stage_cmd",
    displayName: "Cooling Stage Command",
    description: "Number or state of cooling stages commanded.",
    measurement: "status",
    typicalUnit: null,
    isCommand: true,
  },
  {
    pointRole: "heating_stage_cmd",
    displayName: "Heating Stage Command",
    description: "Number or state of heating stages commanded.",
    measurement: "status",
    typicalUnit: null,
    isCommand: true,
  },
  // Energy and electrical -----------------------------------------------------
  {
    pointRole: "power_kw",
    displayName: "Real Power",
    description: "Instantaneous real power draw.",
    measurement: "power",
    typicalUnit: "kW",
  },
  {
    pointRole: "demand_kw",
    displayName: "Peak Demand",
    description: "Demand value used for utility billing.",
    measurement: "power",
    typicalUnit: "kW",
  },
  {
    pointRole: "energy_kwh",
    displayName: "Energy Consumption",
    description:
      "Cumulative electrical energy. Note this is usually a running total, " +
      "not an interval value.",
    measurement: "energy",
    typicalUnit: "kWh",
  },
  {
    pointRole: "current_amps",
    displayName: "Current",
    description: "Electrical current.",
    measurement: "current",
    typicalUnit: "A",
  },
  {
    pointRole: "voltage",
    displayName: "Voltage",
    description: "Electrical potential.",
    measurement: "voltage",
    typicalUnit: "V",
  },
  {
    pointRole: "power_factor",
    displayName: "Power Factor",
    description: "Ratio of real to apparent power.",
    measurement: "ratio",
    typicalUnit: null,
  },
  {
    pointRole: "gas_volume",
    displayName: "Gas Volume",
    description: "Cumulative natural gas volume.",
    measurement: "volume",
    typicalUnit: "ccf",
  },
  {
    pointRole: "water_volume",
    displayName: "Water Volume",
    description: "Cumulative water volume.",
    measurement: "volume",
    typicalUnit: "gal",
  },
  // Operational state ---------------------------------------------------------
  {
    pointRole: "occupancy_status",
    displayName: "Occupancy Status",
    description: "Whether the space or system is currently in occupied mode.",
    measurement: "status",
    typicalUnit: null,
    isStatus: true,
  },
  {
    pointRole: "occupancy_cmd",
    displayName: "Occupancy Command",
    description: "Commanded occupancy mode, usually from a schedule.",
    measurement: "status",
    typicalUnit: null,
    isCommand: true,
  },
  {
    pointRole: "occupancy_sensor",
    displayName: "Occupancy Sensor",
    description: "Physical presence detection in a space.",
    measurement: "status",
    typicalUnit: null,
    isStatus: true,
  },
  {
    pointRole: "occupancy_override",
    displayName: "Occupancy Override",
    description: "Manual after-hours override request.",
    measurement: "status",
    typicalUnit: null,
    isStatus: true,
  },
  {
    pointRole: "system_mode",
    displayName: "System Mode",
    description: "Operating mode, e.g. heating / cooling / off / economizer.",
    measurement: "mode",
    typicalUnit: null,
    isStatus: true,
  },
  {
    pointRole: "alarm_status",
    displayName: "Alarm Status",
    description: "Alarm condition reported by equipment.",
    measurement: "status",
    typicalUnit: null,
    isStatus: true,
  },
  {
    pointRole: "fault_status",
    displayName: "Fault Status",
    description: "Fault condition reported by equipment.",
    measurement: "status",
    typicalUnit: null,
    isStatus: true,
  },
  {
    pointRole: "filter_status",
    displayName: "Filter Status",
    description: "Dirty-filter indication.",
    measurement: "status",
    typicalUnit: null,
    isStatus: true,
  },
  {
    pointRole: "freeze_status",
    displayName: "Freezestat Status",
    description: "Freeze protection trip.",
    measurement: "status",
    typicalUnit: null,
    isStatus: true,
  },
  {
    pointRole: "smoke_status",
    displayName: "Smoke Detector Status",
    description: "Duct or area smoke detection.",
    measurement: "status",
    typicalUnit: null,
    isStatus: true,
  },
  {
    pointRole: "run_hours",
    displayName: "Run Hours",
    description: "Cumulative equipment runtime.",
    measurement: "time",
    typicalUnit: "h",
  },
  {
    pointRole: "start_count",
    displayName: "Start Count",
    description: "Cumulative number of equipment starts.",
    measurement: "count",
    typicalUnit: null,
  },
  // Escape hatch --------------------------------------------------------------
  {
    pointRole: "unclassified",
    displayName: "Unclassified",
    description:
      "Deliberately not yet classified. Distinct from NULL, which means " +
      "nobody has looked. Use this to mark a point as " +
      "reviewed-but-not-mappable.",
    measurement: null,
    typicalUnit: null,
  },
];

export interface BasVocabularySeedResult {
  equipmentTypes: number;
  pointRoles: number;
  setpointLinks: number;
  statusLinks: number;
  /** Roles in the database that this file does not declare. Reported, not deleted. */
  undeclared: string[];
}

/**
 * Idempotent. Safe to re-run on every deploy: a second run leaves every value
 * and every row count exactly as the first left them. It does rewrite the rows
 * rather than skipping them - upsert issues the UPDATE either way - which costs
 * nothing at 116 rows and means a row edited by hand is corrected.
 *
 * TWO PASSES, and the order is not optional. setpoint_for and status_of are
 * self-referencing foreign keys on bas_point_roles, so a single ordered pass
 * would depend on every role appearing after the role it points at - one
 * reordering away from a foreign-key violation. Instead every row is written
 * first with no links, then the links are applied once all of them exist. This
 * is the same shape 002_vocabularies.sql uses, and the reason it uses it.
 *
 * Pass two writes the declared value INCLUDING null, so removing a link from
 * this file removes it from the database. Rows are never deleted: a role a point
 * already references cannot be (the foreign key is RESTRICT), and silently
 * dropping vocabulary out from under existing data would be worse than
 * reporting it.
 */
export async function seedBasVocabularies(
  client: DbClient,
): Promise<BasVocabularySeedResult> {
  for (const type of BAS_EQUIPMENT_TYPES) {
    await client.basEquipmentType.upsert({
      where: { equipType: type.equipType },
      update: {
        displayName: type.displayName,
        description: type.description,
        category: type.category,
      },
      create: type,
    });
  }

  // Pass one: every role, links deliberately left unset.
  for (const role of BAS_POINT_ROLES) {
    const fields = {
      displayName: role.displayName,
      description: role.description,
      measurement: role.measurement,
      typicalUnit: role.typicalUnit,
      // Written explicitly rather than relying on the column default, so a row
      // that is wrong in the database is corrected rather than left alone.
      isSetpoint: role.isSetpoint ?? false,
      isCommand: role.isCommand ?? false,
      isStatus: role.isStatus ?? false,
    };

    await client.basPointRole.upsert({
      where: { pointRole: role.pointRole },
      update: fields,
      create: { pointRole: role.pointRole, ...fields },
    });
  }

  // Pass two: the links, now that every target exists.
  let setpointLinks = 0;
  let statusLinks = 0;
  for (const role of BAS_POINT_ROLES) {
    await client.basPointRole.update({
      where: { pointRole: role.pointRole },
      data: {
        setpointFor: role.setpointFor ?? null,
        statusOf: role.statusOf ?? null,
      },
    });
    if (role.setpointFor !== undefined) setpointLinks += 1;
    if (role.statusOf !== undefined) statusLinks += 1;
  }

  const declared = new Set(BAS_POINT_ROLES.map((r) => r.pointRole));
  const present = await client.basPointRole.findMany({
    select: { pointRole: true },
  });
  const undeclared = present
    .map((r) => r.pointRole)
    .filter((key) => !declared.has(key))
    .sort();

  return {
    equipmentTypes: BAS_EQUIPMENT_TYPES.length,
    pointRoles: BAS_POINT_ROLES.length,
    setpointLinks,
    statusLinks,
    undeclared,
  };
}
