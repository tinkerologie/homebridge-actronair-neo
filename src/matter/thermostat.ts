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
type LimitWrite = Partial<LimitAttributes>

/**
 * A thermostat cluster's attributes as an endpoint currently holds them: what Homebridge restored
 * from its cache, or what an earlier build registered. Untyped on purpose (it comes from disk),
 * so every value is checked before use.
 */
export type CachedThermostatAttributes = Partial<Record<keyof LimitAttributes, unknown>>

/**
 * The writes that move an endpoint from `previous` limit attributes to `next`, in an order
 * matter.js accepts. ThermostatServer rejects a user-limit write outside the *current* absolute
 * limits, and an absolute-limit write that no longer nests the *current* user limits, so one
 * combined write can fail whichever way the ranges moved. Three steps always work:
 *
 * 1. widen the absolute limits to cover both the old and the new user limits;
 * 2. write the new user limits (matter.js reconciles setpoints into them itself);
 * 3. tighten the absolute limits to their new values (skipped when step 1 already did).
 *
 * Returns no writes when nothing differs, so an unchanged cache costs nothing.
 */
export function limitTransitions(previous: CachedThermostatAttributes | undefined, next: LimitAttributes): LimitWrite[] {
  const old = (key: keyof LimitAttributes): number | undefined => {
    const value = previous?.[key]
    return typeof value === 'number' && Number.isFinite(value)
      ? value
      : undefined
  }
  if ((Object.keys(next) as (keyof LimitAttributes)[]).every(key => old(key) === next[key]))
    return []

  const widen: LimitWrite = {}
  const user: LimitWrite = {}
  const tighten: LimitWrite = {}
  for (const scope of ['Heat', 'Cool'] as const) {
    const absMin = `absMin${scope}SetpointLimit` as const
    const absMax = `absMax${scope}SetpointLimit` as const
    const min = `min${scope}SetpointLimit` as const
    const max = `max${scope}SetpointLimit` as const
    widen[absMin] = Math.min(next[absMin], next[min], old(absMin) ?? next[absMin], old(min) ?? next[absMin])
    widen[absMax] = Math.max(next[absMax], next[max], old(absMax) ?? next[absMax], old(max) ?? next[absMax])
    user[min] = next[min]
    user[max] = next[max]
    tighten[absMin] = next[absMin]
    tighten[absMax] = next[absMax]
  }
  const widenIsFinal = (Object.keys(tighten) as (keyof LimitAttributes)[]).every(key => widen[key] === tighten[key])
  return widenIsFinal
    ? [widen, user]
    : [widen, user, tighten]
}

/**
 * Apply limitTransitions() to a live endpoint through `write` (an updateAccessoryState call for
 * the thermostat cluster). Sequential on purpose: each write is checked against the state the
 * previous one left.
 */
export async function reconcileThermostatLimits(
  write: (attributes: LimitWrite) => Promise<unknown> | undefined,
  previous: CachedThermostatAttributes | undefined,
  next: LimitAttributes,
): Promise<void> {
  for (const step of limitTransitions(previous, next))
    await write(step)
}
