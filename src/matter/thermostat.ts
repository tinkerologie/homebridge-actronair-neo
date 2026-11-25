/**
 * Thermostat cluster limits, in Matter's 0.01°C units.
 *
 * matter.js checks the whole cluster, not just the attribute being written:
 * - each user limit must sit inside its absolute limit;
 * - with AutoMode (Homebridge adds it whenever both setpoints are declared) and our zero
 *   deadband, minCool >= minHeat and maxCool >= maxHeat;
 * - every occupied setpoint must sit inside its user limits.
 * A violation at registration is "adjusted" with a warning; a violation in a later
 * `updateAccessoryState` is rejected outright, which Homebridge logs at error level on
 * every poll while the value stays stale. So the limits are made consistent once here and
 * every setpoint pushed to Matter is clamped into them.
 *
 * The device's reported range (NV_Limits) is the authority: the absolute limits are widened
 * from the spec defaults to cover it rather than narrowing the device's range to the defaults.
 */
const SPEC_ABS = {
  heat: { min: 700, max: 3000 },
  cool: { min: 1600, max: 3200 },
} as const

export interface CentiRange { min: number, max: number }

export interface ThermostatLimits {
  heat: CentiRange
  cool: CentiRange
  /** The thermostat cluster's limit attributes, ready to spread into its initial state. */
  attributes: {
    minHeatSetpointLimit: number
    maxHeatSetpointLimit: number
    minCoolSetpointLimit: number
    maxCoolSetpointLimit: number
    absMinHeatSetpointLimit: number
    absMaxHeatSetpointLimit: number
    absMinCoolSetpointLimit: number
    absMaxCoolSetpointLimit: number
  }
}

const centi = (celsius: number): number => Math.round(celsius * 100)

export function thermostatLimits(heatC: { min: number, max: number }, coolC: { min: number, max: number }): ThermostatLimits {
  const heatMin = centi(heatC.min)
  let heatMax = centi(heatC.max)
  let coolMin = centi(coolC.min)
  let coolMax = centi(coolC.max)

  // Zero-deadband AutoMode ordering, adjusted the same way matter.js would.
  coolMin = Math.max(coolMin, heatMin)
  heatMax = Math.min(heatMax, coolMax)
  heatMax = Math.max(heatMax, heatMin)
  coolMax = Math.max(coolMax, coolMin)

  return {
    heat: { min: heatMin, max: heatMax },
    cool: { min: coolMin, max: coolMax },
    attributes: {
      minHeatSetpointLimit: heatMin,
      maxHeatSetpointLimit: heatMax,
      minCoolSetpointLimit: coolMin,
      maxCoolSetpointLimit: coolMax,
      absMinHeatSetpointLimit: Math.min(SPEC_ABS.heat.min, heatMin),
      absMaxHeatSetpointLimit: Math.max(SPEC_ABS.heat.max, heatMax),
      absMinCoolSetpointLimit: Math.min(SPEC_ABS.cool.min, coolMin),
      absMaxCoolSetpointLimit: Math.max(SPEC_ABS.cool.max, coolMax),
    },
  }
}

/** A °C setpoint as 0.01°C, clamped into `range`. */
export function clampSetpoint(celsius: number, range: CentiRange): number {
  return Math.min(Math.max(centi(celsius), range.min), range.max)
}

/** A 0.01°C range as °C. */
export function toCelsius(range: CentiRange): { min: number, max: number } {
  return { min: range.min / 100, max: range.max / 100 }
}

type LimitAttributes = ThermostatLimits['attributes']

/**
 * A thermostat cluster's attributes as an endpoint currently holds them: what Homebridge restored
 * from its cache, or what an earlier build registered. Untyped on purpose (it comes from disk),
 * so every value is checked before use.
 */
export type CachedThermostatAttributes = Partial<Record<keyof LimitAttributes, unknown>>

/**
 * The limit attributes to write when an endpoint outlives its build, or undefined when it already
 * holds them. Homebridge never applies a re-registered or updated accessory's `clusters` to a
 * reused endpoint, so stale limits would otherwise stay and setpoints inside the new limits would
 * be held at, or rejected by, the old ones.
 *
 * All eight are returned together, to travel in the *same* write as the setpoints: Homebridge's
 * updateAccessoryState() only emits an event and returns, so separate writes are not ordered and
 * their failures are never reported. matter.js validates one write as a single transaction, so
 * limits and setpoints in one write are accepted in any direction and any key order (verified on
 * the real ThermostatServer: widening, narrowing and shifted ranges).
 */
export function changedLimits(previous: CachedThermostatAttributes | undefined, next: LimitAttributes): LimitAttributes | undefined {
  const same = (Object.keys(next) as (keyof LimitAttributes)[]).every(key => previous?.[key] === next[key])
  return same
    ? undefined
    : { ...next }
}
