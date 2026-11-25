import type { CharacteristicValue } from 'homebridge'
import { readFileSync } from 'node:fs'
import { HAPStatus } from 'homebridge'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ZoneAccessory } from '../src/accessories/zone.js'
import { StatusResponseSchema } from '../src/neo/schemas.js'
import { NeoState } from '../src/neo/state.js'
import { NeoCommand } from '../src/neo/types.js'

// --- Minimal fake HAP layer -------------------------------------------------
// ponytail: hand-rolled fakes instead of real hap-nodejs machinery — this accessory only
// needs get/set/update semantics, not UUID validation or characteristic perms.

const ServiceTypes = {
  AccessoryInformation: 'AccessoryInformation',
  Switch: 'Switch',
  HeaterCooler: 'HeaterCooler',
  HumiditySensor: 'HumiditySensor',
  TemperatureSensor: 'TemperatureSensor',
  Battery: 'Battery',
}

const CharacteristicTypes = {
  Manufacturer: 'Manufacturer',
  Model: 'Model',
  SerialNumber: 'SerialNumber',
  Name: 'Name',
  On: 'On',
  Active: { ACTIVE: 1, INACTIVE: 0 },
  CurrentHeaterCoolerState: {
    INACTIVE: 0,
    IDLE: 1,
    HEATING: 2,
    COOLING: 3,
  },
  TargetHeaterCoolerState: { AUTO: 0, HEAT: 1, COOL: 2 },
  CurrentTemperature: 'CurrentTemperature',
  HeatingThresholdTemperature: 'HeatingThresholdTemperature',
  CoolingThresholdTemperature: 'CoolingThresholdTemperature',
  CurrentRelativeHumidity: 'CurrentRelativeHumidity',
  StatusActive: 'StatusActive',
  BatteryLevel: 'BatteryLevel',
  ChargingState: { NOT_CHARGEABLE: 0 },
  StatusLowBattery: { BATTERY_LEVEL_NORMAL: 0, BATTERY_LEVEL_LOW: 1 },
}

class FakeCharacteristic {
  value: CharacteristicValue = 0
  props: Record<string, unknown> = {}
  private getHandler?: () => CharacteristicValue
  private setHandler?: (v: CharacteristicValue) => unknown

  onGet(fn: () => CharacteristicValue) {
    this.getHandler = fn
    return this
  }

  onSet(fn: (v: CharacteristicValue) => unknown) {
    this.setHandler = fn
    return this
  }

  setProps(p: Record<string, unknown>) {
    this.props = {
      ...this.props,
      ...p,
    }
    return this
  }

  updateValue(v: CharacteristicValue) {
    this.value = v
    return this
  }

  async invokeSet(v: CharacteristicValue) {
    return this.setHandler?.(v)
  }

  invokeGet() {
    return this.getHandler?.()
  }
}

class FakeService {
  characteristics = new Map<unknown, FakeCharacteristic>()
  constructor(public type: unknown) {}

  getCharacteristic(id: unknown): FakeCharacteristic {
    let c = this.characteristics.get(id)
    if (!c) {
      c = new FakeCharacteristic()
      this.characteristics.set(id, c)
    }
    return c
  }

  setCharacteristic(id: unknown, value: CharacteristicValue) {
    this.getCharacteristic(id).value = value
    return this
  }

  updateCharacteristic(id: unknown, value: CharacteristicValue) {
    this.getCharacteristic(id).value = value
    return this
  }
}

class FakeAccessory {
  services = new Map<unknown, FakeService>()
  context: Record<string, unknown> = {}
  constructor(public displayName: string) {
    // Real PlatformAccessory instances always carry a pre-created AccessoryInformation service.
    this.services.set(ServiceTypes.AccessoryInformation, new FakeService(ServiceTypes.AccessoryInformation))
  }

  getService(type: unknown): FakeService | undefined {
    return this.services.get(type)
  }

  addService(type: unknown): FakeService {
    const s = new FakeService(type)
    this.services.set(type, s)
    return s
  }

  removeService(s: FakeService) {
    for (const [k, v] of this.services) {
      if (v === s)
        this.services.delete(k)
    }
  }
}

class FakeHapStatusError extends Error {
  constructor(public hapStatus: number) {
    super('hap status error')
  }
}

interface MakePlatformOpts {
  zonesAsHeaterCoolers?: boolean
  /** Merged into the fixture's NV_Limits.UserSetpoint_oC. Pass `null` to drop NV_Limits entirely. */
  limits?: Record<string, number> | null
  /**
   * Merged into NV_Limits.UserSetpoint_oC *before* the payload is run through
   * StatusResponseSchema, so string values (as the live API sends elsewhere, e.g.
   * ConnectionDetailsSchema.Port) exercise the schema's z.coerce.number() rather than
   * being hand-typed as numbers by the test.
   */
  rawLimits?: Record<string, string>
  /** Mutates the raw fixture (before schema parsing) — used to exercise sensor edge cases. */
  mutateRaw?: (raw: { lastKnownState: Record<string, never> }) => void
  /** Supported climate modes, as NeoCapabilities reports them. Defaults to cool+heat+auto. */
  modes?: { cool: boolean, heat: boolean, auto: boolean, fan?: boolean }
}

function makePlatform(opts: MakePlatformOpts = {}) {
  const raw = JSON.parse(readFileSync('test/fixtures/rest-status.json', 'utf8'))
  if (opts.rawLimits)
    Object.assign(raw.lastKnownState.NV_Limits.UserSetpoint_oC, opts.rawLimits)
  opts.mutateRaw?.(raw)

  const tree = StatusResponseSchema.parse(raw).lastKnownState as Record<string, unknown>

  if (opts.limits === null) {
    delete tree.NV_Limits
  }
  else if (opts.limits) {
    Object.assign(
      (tree.NV_Limits as { UserSetpoint_oC: Record<string, number> }).UserSetpoint_oC,
      opts.limits,
    )
  }

  const state = new NeoState()
  state.setCloudConnected(true)
  state.replace(tree as never)

  const commands = {
    run: vi.fn().mockResolvedValue('SUCCESS'),
  }
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }

  const platform = {
    Service: ServiceTypes,
    Characteristic: CharacteristicTypes,
    state,
    commands,
    log,
    serial: 'NEO000000',
    capabilities: { modes: opts.modes ?? {
      cool: true,
      heat: true,
      auto: true,
      fan: true,
    } },
    cfg: {
      zonesAsHeaterCoolers: false,
      ...opts,
    },
    api: {
      hap: {
        HAPStatus,
        HapStatusError: FakeHapStatusError,
        Perms: { PAIRED_READ: 'pr', PAIRED_WRITE: 'pw', NOTIFY: 'ev' },
      },
    },
  } as never

  return { platform, state, commands, log }
}

describe('zoneAccessory', () => {
  let accessory: FakeAccessory

  beforeEach(() => {
    accessory = new FakeAccessory('Zone A')
  })

  it('exposes a Switch by default and toggles zone enable/disable with the correct zoneIndex', async () => {
    const { platform, commands } = makePlatform({ zonesAsHeaterCoolers: false })
    void new ZoneAccessory(platform, accessory as never, 0)

    expect(accessory.getService(ServiceTypes.Switch)).toBeDefined()
    expect(accessory.getService(ServiceTypes.HeaterCooler)).toBeUndefined()

    const onChar = accessory.getService(ServiceTypes.Switch)!.getCharacteristic(CharacteristicTypes.On)
    await onChar.invokeSet(true)
    expect(commands.run).toHaveBeenCalledWith(NeoCommand.ZONE_ENABLE, { zoneIndex: 0 })

    await onChar.invokeSet(false)
    expect(commands.run).toHaveBeenCalledWith(NeoCommand.ZONE_DISABLE, { zoneIndex: 0 })
  })

  it('throws a HAP communication error when the enable/disable command fails, rather than resolving as if it succeeded', async () => {
    const { platform, commands } = makePlatform({ zonesAsHeaterCoolers: false })
    commands.run.mockResolvedValue('FAILURE')
    void new ZoneAccessory(platform, accessory as never, 0)

    const onChar = accessory.getService(ServiceTypes.Switch)!.getCharacteristic(CharacteristicTypes.On)
    await expect(onChar.invokeSet(true)).rejects.toBeTruthy()
  })

  it('throws a HAP communication error when a zone setpoint command API_ERRORs', async () => {
    const { platform, commands } = makePlatform({ zonesAsHeaterCoolers: true })
    commands.run.mockResolvedValue('API_ERROR')
    void new ZoneAccessory(platform, accessory as never, 0)

    const svc = accessory.getService(ServiceTypes.HeaterCooler)!
    await expect(svc.getCharacteristic(CharacteristicTypes.CoolingThresholdTemperature).invokeSet(24)).rejects.toBeTruthy()
  })

  it('reflects EnabledZones for its own index on the Switch', () => {
    const { platform } = makePlatform({ zonesAsHeaterCoolers: false })
    void new ZoneAccessory(platform, accessory as never, 0)
    const onChar = accessory.getService(ServiceTypes.Switch)!.getCharacteristic(CharacteristicTypes.On)
    // Fixture: EnabledZones[0] === true
    expect(onChar.invokeGet()).toBe(true)
  })

  it('exposes a HeaterCooler with humidity sensor when zonesAsHeaterCoolers is true', () => {
    const { platform } = makePlatform({ zonesAsHeaterCoolers: true })
    void new ZoneAccessory(platform, accessory as never, 0)

    expect(accessory.getService(ServiceTypes.HeaterCooler)).toBeDefined()
    expect(accessory.getService(ServiceTypes.HumiditySensor)).toBeDefined()
    expect(accessory.getService(ServiceTypes.Switch)).toBeUndefined()
  })

  it('reads zone values from RemoteZoneInfo[i] paths', () => {
    const { platform } = makePlatform({ zonesAsHeaterCoolers: true })
    void new ZoneAccessory(platform, accessory as never, 0)
    const svc = accessory.getService(ServiceTypes.HeaterCooler)!

    // Fixture zone 0 ("Zone A"): LiveTemp_oC 21.2, TemperatureSetpoint_Cool_oC 23, Heat 21.5
    expect(svc.getCharacteristic(CharacteristicTypes.CurrentTemperature).invokeGet()).toBe(21.2)
    expect(svc.getCharacteristic(CharacteristicTypes.CoolingThresholdTemperature).invokeGet()).toBe(23)
    expect(svc.getCharacteristic(CharacteristicTypes.HeatingThresholdTemperature).invokeGet()).toBe(21.5)
  })

  it('issues ZONE_HEAT_SET_POINT / ZONE_COOL_SET_POINT with the correct zoneIndex for a different zone', async () => {
    const { platform, commands } = makePlatform({ zonesAsHeaterCoolers: true })
    const acc2 = new FakeAccessory('Zone B')
    void new ZoneAccessory(platform, acc2 as never, 1)
    const svc = acc2.getService(ServiceTypes.HeaterCooler)!

    await svc.getCharacteristic(CharacteristicTypes.CoolingThresholdTemperature).invokeSet(22)
    expect(commands.run).toHaveBeenCalledWith(NeoCommand.ZONE_COOL_SET_POINT, { coolTemp: 22, zoneIndex: 1 })
  })

  it('neo: honours the symmetric ZoneTemperatureSetpointVariance_oC (real fixture: 2) when every NV_Limits variance is 0', async () => {
    // A live NTW-1000 and the fixture both report the NV_Limits.UserSetpoint_oC variances as 0
    // and ZoneTemperatureSetpointVariance_oC as 2. The Neo app constrains zones with the latter
    // (upstream ActronAirAPI 96e8a31), so a zone may not sit more than 2 degrees from the master.
    const { platform, commands } = makePlatform({ zonesAsHeaterCoolers: true })
    void new ZoneAccessory(platform, accessory as never, 0)
    const svc = accessory.getService(ServiceTypes.HeaterCooler)!

    // Master cool setpoint is 22; 28 is outside [20, 24], so the master moves to 28 - 2 = 26.
    await svc.getCharacteristic(CharacteristicTypes.CoolingThresholdTemperature).invokeSet(28)

    expect(commands.run).toHaveBeenCalledWith(NeoCommand.COOL_SET_POINT, { coolTemp: 26 })
    expect(commands.run).toHaveBeenCalledWith(NeoCommand.ZONE_COOL_SET_POINT, { coolTemp: 28, zoneIndex: 0 })
  })

  it.each([
    ['zero', 0],
    ['absent', undefined],
  ])('no constraint when every variance is 0 and ZoneTemperatureSetpointVariance_oC is %s', async (_label, variance) => {
    const { platform, commands } = makePlatform({
      zonesAsHeaterCoolers: true,
      mutateRaw: (raw) => {
        const settings = raw.lastKnownState.UserAirconSettings as unknown as Record<string, unknown>
        if (variance === undefined)
          delete settings.ZoneTemperatureSetpointVariance_oC
        else
          settings.ZoneTemperatureSetpointVariance_oC = variance
      },
    })
    void new ZoneAccessory(platform, accessory as never, 0)
    const svc = accessory.getService(ServiceTypes.HeaterCooler)!

    await svc.getCharacteristic(CharacteristicTypes.CoolingThresholdTemperature).invokeSet(28)

    expect(commands.run).not.toHaveBeenCalledWith(NeoCommand.COOL_SET_POINT, expect.anything())
    expect(commands.run).toHaveBeenCalledWith(NeoCommand.ZONE_COOL_SET_POINT, { coolTemp: 28, zoneIndex: 0 })
  })

  it('a non-zero NV_Limits variance takes precedence over the symmetric field', async () => {
    const { platform, commands } = makePlatform({
      zonesAsHeaterCoolers: true,
      limits: { VarianceAboveMasterCool: 3, VarianceBelowMasterCool: 3 },
    })
    void new ZoneAccessory(platform, accessory as never, 0)
    const svc = accessory.getService(ServiceTypes.HeaterCooler)!

    // [19, 25] from NV_Limits, not [20, 24]: 28 moves the master to 28 - 3 = 25.
    await svc.getCharacteristic(CharacteristicTypes.CoolingThresholdTemperature).invokeSet(28)

    expect(commands.run).toHaveBeenCalledWith(NeoCommand.COOL_SET_POINT, { coolTemp: 25 })
  })

  it('non-zero variance, target above the band: master is nudged by the variance offset (not to the target itself) so the band re-includes the zone value', async () => {
    const { platform, commands } = makePlatform({
      zonesAsHeaterCoolers: true,
      limits: { VarianceAboveMasterCool: 2, VarianceBelowMasterCool: 2 },
    })
    void new ZoneAccessory(platform, accessory as never, 0)
    const svc = accessory.getService(ServiceTypes.HeaterCooler)!

    // Master cool setpoint is 22; requesting 28 violates the (now non-zero) ±2 variance
    // (band [20, 24]). Above the band -> master should move to target - above = 28 - 2 = 26,
    // not to 28 (which would need "target + above" to sit inside its own band).
    await svc.getCharacteristic(CharacteristicTypes.CoolingThresholdTemperature).invokeSet(28)

    expect(commands.run).toHaveBeenCalledWith(NeoCommand.COOL_SET_POINT, { coolTemp: 26 })
    expect(commands.run).toHaveBeenCalledWith(NeoCommand.ZONE_COOL_SET_POINT, { coolTemp: 28, zoneIndex: 0 })
  })

  it('non-zero variance, target below the band: master is nudged to target + below', async () => {
    const { platform, commands } = makePlatform({
      zonesAsHeaterCoolers: true,
      limits: { VarianceAboveMasterCool: 2, VarianceBelowMasterCool: 2 },
    })
    void new ZoneAccessory(platform, accessory as never, 0)
    const svc = accessory.getService(ServiceTypes.HeaterCooler)!

    // Master cool setpoint is 22, band [20, 24]. Requesting 17 (clamped by absolute bounds
    // setCool_Min 16) is below the band -> master should move to target + below = 17 + 2 = 19.
    await svc.getCharacteristic(CharacteristicTypes.CoolingThresholdTemperature).invokeSet(17)

    expect(commands.run).toHaveBeenCalledWith(NeoCommand.COOL_SET_POINT, { coolTemp: 19 })
    expect(commands.run).toHaveBeenCalledWith(NeoCommand.ZONE_COOL_SET_POINT, { coolTemp: 17, zoneIndex: 0 })
  })

  it('non-zero variance applies symmetrically to heating setpoints', async () => {
    const { platform, commands } = makePlatform({
      zonesAsHeaterCoolers: true,
      limits: { VarianceAboveMasterHeat: 2, VarianceBelowMasterHeat: 2 },
    })
    void new ZoneAccessory(platform, accessory as never, 0)
    const svc = accessory.getService(ServiceTypes.HeaterCooler)!

    // Master heat setpoint is 22, band [20, 24]. Requesting 18 is below it -> the master is
    // nudged to target + below = 20 and the zone keeps the value the user asked for.
    await svc.getCharacteristic(CharacteristicTypes.HeatingThresholdTemperature).invokeSet(18)

    expect(commands.run).toHaveBeenCalledWith(NeoCommand.HEAT_SET_POINT, { heatTemp: 20 })
    expect(commands.run).toHaveBeenCalledWith(NeoCommand.ZONE_HEAT_SET_POINT, { heatTemp: 18, zoneIndex: 0 })
  })

  it('produces correct arithmetic when the device reports limits as strings (regression: "+" concatenation, not addition)', async () => {
    // Unvalidated `target + "2"` would yield the string "172" instead of 19. Routed through
    // StatusResponseSchema (via rawLimits, applied pre-parse) so the schema's coercion is
    // what's under test, not a hand-typed number in the test.
    const { platform, commands } = makePlatform({
      zonesAsHeaterCoolers: true,
      rawLimits: { VarianceAboveMasterCool: '2', VarianceBelowMasterCool: '2' },
    })
    void new ZoneAccessory(platform, accessory as never, 0)
    const svc = accessory.getService(ServiceTypes.HeaterCooler)!

    // Master cool setpoint is 22, band [20, 24]. Requesting 17 nudges the master to
    // target + below, which must be the number 19 and not the string "172".
    await svc.getCharacteristic(CharacteristicTypes.CoolingThresholdTemperature).invokeSet(17)

    expect(commands.run).toHaveBeenCalledWith(NeoCommand.COOL_SET_POINT, { coolTemp: 19 })
  })

  it('absolute bounds are respected even with no variance constraint', async () => {
    const { platform, commands } = makePlatform({ zonesAsHeaterCoolers: true })
    void new ZoneAccessory(platform, accessory as never, 0)
    const svc = accessory.getService(ServiceTypes.HeaterCooler)!

    // Fixture NV_Limits.UserSetpoint_oC: setCool_Max 30, setHeat_Min 16.
    await svc.getCharacteristic(CharacteristicTypes.CoolingThresholdTemperature).invokeSet(35)
    expect(commands.run).toHaveBeenCalledWith(NeoCommand.ZONE_COOL_SET_POINT, { coolTemp: 30, zoneIndex: 0 })

    await svc.getCharacteristic(CharacteristicTypes.HeatingThresholdTemperature).invokeSet(5)
    expect(commands.run).toHaveBeenCalledWith(NeoCommand.ZONE_HEAT_SET_POINT, { heatTemp: 16, zoneIndex: 0 })
  })

  it('falls back to the built-in min/max temps without crashing when NV_Limits is absent entirely', async () => {
    const { platform, commands } = makePlatform({ zonesAsHeaterCoolers: true, limits: null })
    expect(() => new ZoneAccessory(platform, accessory as never, 0)).not.toThrow()
    const svc = accessory.getService(ServiceTypes.HeaterCooler)!

    // Built-in fallback: cool 20-32 — a value above the device max but within those bounds
    // passes through; nothing crashes reading undefined limits.
    await svc.getCharacteristic(CharacteristicTypes.CoolingThresholdTemperature).invokeSet(31)
    expect(commands.run).toHaveBeenCalledWith(NeoCommand.ZONE_COOL_SET_POINT, { coolTemp: 31, zoneIndex: 0 })

    await svc.getCharacteristic(CharacteristicTypes.CoolingThresholdTemperature).invokeSet(50)
    expect(commands.run).toHaveBeenCalledWith(NeoCommand.ZONE_COOL_SET_POINT, { coolTemp: 32, zoneIndex: 0 })
  })

  it('throws SERVICE_COMMUNICATION_FAILURE when writing while the cloud is disconnected', async () => {
    const { platform, state } = makePlatform({ zonesAsHeaterCoolers: false })
    state.setCloudConnected(false)
    void new ZoneAccessory(platform, accessory as never, 0)
    const onChar = accessory.getService(ServiceTypes.Switch)!.getCharacteristic(CharacteristicTypes.On)

    await expect(onChar.invokeSet(true)).rejects.toThrow()
  })

  it('updates its own characteristics on a delta scoped to its zone index', () => {
    const { platform, state } = makePlatform({ zonesAsHeaterCoolers: false })
    void new ZoneAccessory(platform, accessory as never, 0)
    const onChar = accessory.getService(ServiceTypes.Switch)!.getCharacteristic(CharacteristicTypes.On)

    state.applyDelta({
      'UserAirconSettings.EnabledZones': [
        false,
        false,
        false,
        false,
        true,
        false,
        false,
        false,
      ],
    })
    expect(onChar.value).toBe(false)
  })

  it('updates Active/CurrentHeaterCoolerState/TargetHeaterCoolerState when the master is turned off, even though nothing zone-specific changed', () => {
    // Fixture: UserAirconSettings.isOn starts false, so turn it on first to get a real
    // ACTIVE -> INACTIVE transition to observe.
    const { platform, state } = makePlatform({ zonesAsHeaterCoolers: true })
    state.applyDelta({ 'UserAirconSettings.isOn': true })
    void new ZoneAccessory(platform, accessory as never, 0)
    const svc = accessory.getService(ServiceTypes.HeaterCooler)!
    const activeChar = svc.getCharacteristic(CharacteristicTypes.Active)
    activeChar.value = CharacteristicTypes.Active.ACTIVE

    state.applyDelta({ 'UserAirconSettings.isOn': false })

    expect(activeChar.value).toBe(CharacteristicTypes.Active.INACTIVE)
  })

  it('holds the last real target state when the master goes fan-only, instead of claiming AUTO', () => {
    // Flattening FAN to AUTO made every zone tile contradict the master's own tile (which holds
    // its last heat/cool/auto value), and claim a mode a unit without AUTO hasn't got.
    const { platform, state } = makePlatform({ zonesAsHeaterCoolers: true })
    state.applyDelta({ 'UserAirconSettings.Mode': 'COOL' })
    void new ZoneAccessory(platform, accessory as never, 0)
    const targetChar = accessory.getService(ServiceTypes.HeaterCooler)!
      .getCharacteristic(CharacteristicTypes.TargetHeaterCoolerState)

    state.applyDelta({ 'UserAirconSettings.Mode': 'FAN' })

    expect(targetChar.value).toBe(CharacteristicTypes.TargetHeaterCoolerState.COOL)
  })

  it('ignores deltas that belong to a different zone', () => {
    const { platform, state } = makePlatform({ zonesAsHeaterCoolers: true })
    void new ZoneAccessory(platform, accessory as never, 0)
    const svc = accessory.getService(ServiceTypes.HeaterCooler)!
    const tempChar = svc.getCharacteristic(CharacteristicTypes.CurrentTemperature)
    tempChar.value = 21.2

    state.applyDelta({ 'RemoteZoneInfo[1].LiveTemp_oC': 30 })

    expect(tempChar.value).toBe(21.2)
  })

  it('updates on a full-load "*" change', () => {
    const { platform } = makePlatform({ zonesAsHeaterCoolers: true })

    // A replace() on an already-populated state produces a leaf-level diff, not '*' — so
    // drive the '*' path directly via a brand-new, empty state to match the "first full
    // load" contract (see NeoState.replace()).
    const fresh = new NeoState()
    fresh.setCloudConnected(true)
    const freshAccessory = new FakeAccessory('Zone A')
    const freshPlatform = { ...platform, state: fresh }
    void new ZoneAccessory(freshPlatform as never, freshAccessory as never, 0)
    const freshChar = freshAccessory.getService(ServiceTypes.HeaterCooler)!.getCharacteristic(CharacteristicTypes.CurrentTemperature)

    fresh.replace(StatusResponseSchema.parse(
      JSON.parse(readFileSync('test/fixtures/rest-status.json', 'utf8')),
    ).lastKnownState)

    expect(freshChar.value).toBe(21.2)
  })
})

describe('zoneAccessory sensors (battery, temperature, humidity)', () => {
  // Real fixture: Zone A/B/C/D (indices 0-3) are wireless zone sensors (NV_Kind "ZS: SN00000X")
  // resolving against AirconSystem.Peripherals at 52/57/52/59%. Zone E (index 4) is wired
  // (NV_Kind "C1") and has no battery at all.
  const wirelessZones = [
    { index: 0, name: 'Zone A', battery: 52 },
    { index: 1, name: 'Zone B', battery: 57 },
    { index: 2, name: 'Zone C', battery: 52 },
    { index: 3, name: 'Zone D', battery: 59 },
  ]

  it.each(wirelessZones)('resolves the real battery for $name (not the old fake 100)', ({ index, name, battery }) => {
    const { platform } = makePlatform()
    const accessory = new FakeAccessory(name)
    void new ZoneAccessory(platform, accessory as never, index)

    const batterySvc = accessory.getService(ServiceTypes.Battery)
    expect(batterySvc).toBeDefined()
    expect(batterySvc!.getCharacteristic(CharacteristicTypes.BatteryLevel).invokeGet()).toBe(battery)
  })

  it('gives the wired zone (Zone E) no Battery service at all', () => {
    const { platform } = makePlatform()
    const accessory = new FakeAccessory('Zone E')
    void new ZoneAccessory(platform, accessory as never, 4)

    expect(accessory.getService(ServiceTypes.Battery)).toBeUndefined()
  })

  it('a wireless zone whose serial matches no Peripherals entry gets no Battery service (no fabricated level)', () => {
    const { platform } = makePlatform({
      mutateRaw: (raw) => {
        raw.lastKnownState.AirconSystem.Peripherals = raw.lastKnownState.AirconSystem.Peripherals
          .filter((p: { SerialNumber: string }) => p.SerialNumber !== 'SN000003')
      },
    })
    const accessory = new FakeAccessory('Zone A')
    void new ZoneAccessory(platform, accessory as never, 0)

    expect(accessory.getService(ServiceTypes.Battery)).toBeUndefined()
  })

  it('peripherals absent entirely: no crash, no invented battery for any zone', () => {
    const { platform } = makePlatform({
      mutateRaw: (raw) => {
        delete raw.lastKnownState.AirconSystem.Peripherals
      },
    })
    const accessory = new FakeAccessory('Zone A')
    expect(() => new ZoneAccessory(platform, accessory as never, 0)).not.toThrow()
    expect(accessory.getService(ServiceTypes.Battery)).toBeUndefined()
  })

  it('sensors map absent on a zone: treated as unknown, no Battery service', () => {
    const { platform } = makePlatform({
      mutateRaw: (raw) => {
        delete raw.lastKnownState.RemoteZoneInfo[0].Sensors
      },
    })
    const accessory = new FakeAccessory('Zone A')
    void new ZoneAccessory(platform, accessory as never, 0)

    expect(accessory.getService(ServiceTypes.Battery)).toBeUndefined()
  })

  it('nV_Kind missing on the zone\'s sensor entry: treated as unknown, no Battery service', () => {
    const { platform } = makePlatform({
      mutateRaw: (raw) => {
        for (const entry of Object.values(raw.lastKnownState.RemoteZoneInfo[0].Sensors) as Record<string, unknown>[])
          delete entry.NV_Kind
      },
    })
    const accessory = new FakeAccessory('Zone A')
    void new ZoneAccessory(platform, accessory as never, 0)

    expect(accessory.getService(ServiceTypes.Battery)).toBeUndefined()
  })

  it('low-battery threshold: below 20% trips StatusLowBattery, at/above does not', () => {
    const { platform: lowPlatform } = makePlatform({
      mutateRaw: (raw) => {
        raw.lastKnownState.AirconSystem.Peripherals.find((p: { SerialNumber: string }) => p.SerialNumber === 'SN000003')!.RemainingBatteryCapacity_pc = 19
      },
    })
    const lowAccessory = new FakeAccessory('Zone A')
    void new ZoneAccessory(lowPlatform, lowAccessory as never, 0)
    const lowBatterySvc = lowAccessory.getService(ServiceTypes.Battery)!
    expect(lowBatterySvc.getCharacteristic(CharacteristicTypes.StatusLowBattery).invokeGet())
      .toBe(CharacteristicTypes.StatusLowBattery.BATTERY_LEVEL_LOW)

    const { platform: okPlatform } = makePlatform({
      mutateRaw: (raw) => {
        raw.lastKnownState.AirconSystem.Peripherals.find((p: { SerialNumber: string }) => p.SerialNumber === 'SN000003')!.RemainingBatteryCapacity_pc = 20
      },
    })
    const okAccessory = new FakeAccessory('Zone A')
    void new ZoneAccessory(okPlatform, okAccessory as never, 0)
    const okBatterySvc = okAccessory.getService(ServiceTypes.Battery)!
    expect(okBatterySvc.getCharacteristic(CharacteristicTypes.StatusLowBattery).invokeGet())
      .toBe(CharacteristicTypes.StatusLowBattery.BATTERY_LEVEL_NORMAL)
  })

  it('switch mode (default): exposes TemperatureSensor + HumiditySensor with real fixture values', () => {
    const { platform } = makePlatform({ zonesAsHeaterCoolers: false })
    const accessory = new FakeAccessory('Zone A')
    void new ZoneAccessory(platform, accessory as never, 0)

    const tempSvc = accessory.getService(ServiceTypes.TemperatureSensor)
    const humiditySvc = accessory.getService(ServiceTypes.HumiditySensor)
    expect(tempSvc).toBeDefined()
    expect(humiditySvc).toBeDefined()
    // Fixture Zone A: LiveTemp_oC 21.2, LiveHumidity_pc 66.5.
    expect(tempSvc!.getCharacteristic(CharacteristicTypes.CurrentTemperature).invokeGet()).toBe(21.2)
    expect(humiditySvc!.getCharacteristic(CharacteristicTypes.CurrentRelativeHumidity).invokeGet()).toBe(66.5)
  })

  it('heaterCooler mode: no duplicate TemperatureSensor (HeaterCooler already carries CurrentTemperature)', () => {
    const { platform } = makePlatform({ zonesAsHeaterCoolers: true })
    const accessory = new FakeAccessory('Zone A')
    void new ZoneAccessory(platform, accessory as never, 0)

    expect(accessory.getService(ServiceTypes.TemperatureSensor)).toBeUndefined()
    expect(accessory.getService(ServiceTypes.HeaterCooler)!.getCharacteristic(CharacteristicTypes.CurrentTemperature).invokeGet()).toBe(21.2)
    expect(accessory.getService(ServiceTypes.HumiditySensor)).toBeDefined()
  })

  it('humidity absent: no HumiditySensor service, no fabricated value', () => {
    const { platform } = makePlatform({
      mutateRaw: (raw) => {
        delete raw.lastKnownState.RemoteZoneInfo[0].LiveHumidity_pc
      },
    })
    const accessory = new FakeAccessory('Zone A')
    void new ZoneAccessory(platform, accessory as never, 0)

    expect(accessory.getService(ServiceTypes.HumiditySensor)).toBeUndefined()
  })

  it('toggling zonesAsHeaterCoolers does not leave an orphaned TemperatureSensor', () => {
    const { platform: switchPlatform } = makePlatform({ zonesAsHeaterCoolers: false })
    const accessory = new FakeAccessory('Zone A')
    void new ZoneAccessory(switchPlatform, accessory as never, 0)
    expect(accessory.getService(ServiceTypes.TemperatureSensor)).toBeDefined()

    // Same accessory instance, switched to heaterCooler mode (as syncAccessories does on
    // an existing cached accessory) — the stale standalone TemperatureSensor must be removed.
    const { platform: hcPlatform } = makePlatform({ zonesAsHeaterCoolers: true })
    void new ZoneAccessory(hcPlatform, accessory as never, 0)
    expect(accessory.getService(ServiceTypes.TemperatureSensor)).toBeUndefined()
    expect(accessory.getService(ServiceTypes.HeaterCooler)).toBeDefined()

    // And back again — HeaterCooler removed, TemperatureSensor restored.
    void new ZoneAccessory(switchPlatform, accessory as never, 0)
    expect(accessory.getService(ServiceTypes.HeaterCooler)).toBeUndefined()
    expect(accessory.getService(ServiceTypes.TemperatureSensor)).toBeDefined()
  })

  it('event-driven: a Peripherals-only delta (no RemoteZoneInfo change) still refreshes battery/StatusActive', () => {
    const { platform, state } = makePlatform()
    const accessory = new FakeAccessory('Zone A')
    void new ZoneAccessory(platform, accessory as never, 0)
    const batterySvc = accessory.getService(ServiceTypes.Battery)!
    const levelChar = batterySvc.getCharacteristic(CharacteristicTypes.BatteryLevel)
    levelChar.value = 52

    state.applyDelta({ 'AirconSystem.Peripherals[0].RemainingBatteryCapacity_pc': 40 })

    expect(levelChar.value).toBe(40)
  })

  it('a dropped wireless sensor reports StatusActive false rather than silently serving a stale reading', () => {
    const { platform } = makePlatform({
      mutateRaw: (raw) => {
        raw.lastKnownState.AirconSystem.Peripherals.find((p: { SerialNumber: string }) => p.SerialNumber === 'SN000003')!.ConnectionState = 'Disconnected'
      },
    })
    const accessory = new FakeAccessory('Zone A')
    void new ZoneAccessory(platform, accessory as never, 0)

    const tempSvc = accessory.getService(ServiceTypes.TemperatureSensor)!
    expect(tempSvc.getCharacteristic(CharacteristicTypes.StatusActive).invokeGet()).toBe(false)
  })
  it('never serves the cloud\'s 3000 sentinel into CurrentTemperature (HAP caps it at 100)', () => {
    const { platform } = makePlatform({
      zonesAsHeaterCoolers: true,
      mutateRaw: (raw) => {
        (raw.lastKnownState as never as { RemoteZoneInfo: Array<{ LiveTemp_oC: number }> }).RemoteZoneInfo[0].LiveTemp_oC = 3000
      },
    })
    const accessory = new FakeAccessory('Zone A')
    void new ZoneAccessory(platform, accessory as never, 0)

    const temp = accessory.getService(ServiceTypes.HeaterCooler)!
      .getCharacteristic(CharacteristicTypes.CurrentTemperature)
      .invokeGet()
    expect(temp).not.toBe(3000)
  })

  it('serves the last known-good zone temperature when the reading turns implausible', () => {
    const { platform, state } = makePlatform({ zonesAsHeaterCoolers: true })
    const accessory = new FakeAccessory('Zone A')
    void new ZoneAccessory(platform, accessory as never, 0)
    const char = accessory.getService(ServiceTypes.HeaterCooler)!
      .getCharacteristic(CharacteristicTypes.CurrentTemperature)
    expect(char.invokeGet()).toBe(21.2)

    state.applyDelta({ 'RemoteZoneInfo[0].LiveTemp_oC': 3000 })

    expect(char.invokeGet()).toBe(21.2)
  })

  it('fails the HomeKit setter when the master nudge itself fails, rather than reporting the zone value as applied', async () => {
    const { platform, commands } = makePlatform({
      zonesAsHeaterCoolers: true,
      limits: { VarianceAboveMasterCool: 2, VarianceBelowMasterCool: 2 },
    })
    commands.run.mockImplementation(async (command: string) =>
      command === NeoCommand.COOL_SET_POINT
        ? 'API_ERROR'
        : 'SUCCESS')
    const accessory = new FakeAccessory('Zone A')
    void new ZoneAccessory(platform, accessory as never, 0)

    const cool = accessory.getService(ServiceTypes.HeaterCooler)!
      .getCharacteristic(CharacteristicTypes.CoolingThresholdTemperature)
    // Fixture master cool setpoint is 23 with a ±2 band once the variance is non-zero.
    await expect(cool.invokeSet(29)).rejects.toBeTruthy()
  })
})

describe('zoneAccessory HAP value hygiene', () => {
  let accessory: FakeAccessory
  beforeEach(() => {
    accessory = new FakeAccessory('Zone A')
  })

  it('threshold getters never serve a value outside the characteristic range (no bare 0)', () => {
    const { platform, state } = makePlatform({ zonesAsHeaterCoolers: true })
    void new ZoneAccessory(platform, accessory as never, 0)
    const svc = accessory.getService(ServiceTypes.HeaterCooler)!
    const heat = svc.getCharacteristic(CharacteristicTypes.HeatingThresholdTemperature)
    const cool = svc.getCharacteristic(CharacteristicTypes.CoolingThresholdTemperature)

    state.applyDelta({ 'RemoteZoneInfo[0].TemperatureSetpoint_Heat_oC': 99, 'RemoteZoneInfo[0].TemperatureSetpoint_Cool_oC': 1 })
    expect(heat.invokeGet()).toBe(heat.props.maxValue)
    expect(cool.invokeGet()).toBe(cool.props.minValue)
  })

  it('threshold getters fall back to the range minimum, not 0, when the zone reports no setpoint', () => {
    const { platform } = makePlatform({
      zonesAsHeaterCoolers: true,
      mutateRaw: (raw) => {
        const zone = (raw.lastKnownState.RemoteZoneInfo as unknown as Record<string, unknown>[])[0]
        delete zone.TemperatureSetpoint_Heat_oC
        delete zone.TemperatureSetpoint_Cool_oC
      },
    })
    void new ZoneAccessory(platform, accessory as never, 0)
    const svc = accessory.getService(ServiceTypes.HeaterCooler)!
    const heat = svc.getCharacteristic(CharacteristicTypes.HeatingThresholdTemperature)
    const cool = svc.getCharacteristic(CharacteristicTypes.CoolingThresholdTemperature)
    expect(heat.invokeGet()).toBe(heat.props.minValue)
    expect(cool.invokeGet()).toBe(cool.props.minValue)
    // Seeded right after setProps, so HAP never holds its out-of-range default either.
    expect(heat.value).toBe(heat.props.minValue)
  })

  it('target mode is a read-only mirror limited to the modes the unit supports', () => {
    const { platform, state } = makePlatform({
      zonesAsHeaterCoolers: true,
      modes: { cool: true, heat: false, auto: false },
    })
    void new ZoneAccessory(platform, accessory as never, 0)
    const target = accessory.getService(ServiceTypes.HeaterCooler)!.getCharacteristic(CharacteristicTypes.TargetHeaterCoolerState)
    expect(target.props.validValues).toEqual([CharacteristicTypes.TargetHeaterCoolerState.COOL])
    expect(target.props.perms).toEqual(['pr', 'ev'])
    // Even if the master reports a mode outside validValues, the getter never serves it.
    state.applyDelta({ 'UserAirconSettings.Mode': 'HEAT' })
    expect(target.invokeGet()).toBe(CharacteristicTypes.TargetHeaterCoolerState.COOL)
  })

  it('switch mode serves On as a boolean (its HAP format)', () => {
    const { platform, state } = makePlatform()
    const zone = new ZoneAccessory(platform, accessory as never, 0)
    state.applyDelta({
      'UserAirconSettings.EnabledZones': [
        true,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
      ],
    })
    expect(zone.getEnableState()).toBe(true)
    state.applyDelta({
      'UserAirconSettings.EnabledZones': [
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
      ],
    })
    expect(zone.getEnableState()).toBe(false)
  })
})

it('stops state pushes when disposed', () => {
  const { platform, state } = makePlatform()
  const accessory = new FakeAccessory('Zone A')
  const zone = new ZoneAccessory(platform, accessory as never, 0)
  const update = vi.spyOn(accessory.getService(ServiceTypes.Switch)!, 'updateCharacteristic')
  zone.dispose()
  state.applyDelta({ 'UserAirconSettings.EnabledZones[0]': !state.get('UserAirconSettings.EnabledZones[0]') })
  expect(update).not.toHaveBeenCalled()
})
