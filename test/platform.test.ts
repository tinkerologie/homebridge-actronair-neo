import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ZoneAccessory } from '../src/accessories/zone.js'
import { NeoAuthRevokedError } from '../src/neo/auth.js'
import { NeoMqtt } from '../src/neo/mqtt.js'
import { NeoCommand } from '../src/neo/types.js'
import { ActronAirNeoPlatform, sanitizeAccessoryName } from '../src/platform.js'

vi.mock('../src/accessories/zone.js', () => ({
  ZoneAccessory: vi.fn(),
}))

// The platform tests cover orchestration, not the HAP wrappers (each has its own test file).
// The fake PlatformAccessory here has no services, so the real wrappers would throw on
// construction, and the platform deliberately never registers a new accessory that failed to
// build. Stand-ins that construct cleanly keep these tests about the platform.
function stubWrapper() {
  return vi.fn().mockImplementation(function (this: { dispose: () => void }) {
    this.dispose = vi.fn()
  })
}
vi.mock('../src/accessories/master.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/accessories/master.js')>(),
  MasterAccessory: stubWrapper(),
}))
vi.mock('../src/accessories/modeSwitch.js', () => ({
  ModeSwitchAccessory: stubWrapper(),
}))
vi.mock('../src/accessories/outdoorTemp.js', () => ({
  OutdoorTempAccessory: stubWrapper(),
}))
vi.mock('../src/accessories/afterHours.js', () => ({
  AfterHoursAccessory: stubWrapper(),
}))

vi.mock('../src/neo/mqtt.js', () => ({
  NeoMqtt: vi.fn().mockImplementation(function NeoMqtt(this: Record<string, unknown>, opts: { onHealthChange?: (healthy: boolean) => void }) {
    this.start = vi.fn().mockResolvedValue(undefined)
    this.stop = vi.fn()
    this.healthy = false
    this.opts = opts
  }),
}))

const restStatus = JSON.parse(readFileSync('test/fixtures/rest-status.json', 'utf8'))
const systems = JSON.parse(readFileSync('test/fixtures/ac-systems.json', 'utf8'))

function makeApi(options: { matterEnabled?: boolean } = {}) {
  const handlers: Record<string, () => void> = {}
  const matterMock = options.matterEnabled
    ? {
        uuid: {
          generate: (s: string) => `matter-uuid-${s}`,
        },
        deviceTypes: {
          Thermostat: { name: 'Thermostat' },
          Fan: { name: 'Fan' },
          HumiditySensor: { name: 'HumiditySensor' },
          TemperatureSensor: { name: 'TemperatureSensor' },
          OnOffSwitch: { name: 'OnOffSwitch' },
          WaterValve: { name: 'WaterValve' },
        },
        registerPlatformAccessories: vi.fn().mockResolvedValue(undefined),
        unregisterPlatformAccessories: vi.fn().mockResolvedValue(undefined),
        updatePlatformAccessories: vi.fn().mockResolvedValue(undefined),
        updateAccessoryState: vi.fn().mockResolvedValue(undefined),
      }
    : undefined

  return {
    hap: {
      Service: {},
      Characteristic: {},
      uuid: {
        generate: (s: string) => `uuid-${s}`,
      },
      HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 },
      HapStatusError: class {},
    },
    user: {
      storagePath: () => '/tmp/hb',
    },
    on: (event: string, cb: () => void) => { handlers[event] = cb },
    platformAccessory: class {
      context: Record<string, unknown> = {}
      services: unknown[] = []
      constructor(public displayName: string, public UUID: string, public category?: number) {}
    },
    registerPlatformAccessories: vi.fn(),
    unregisterPlatformAccessories: vi.fn(),
    updatePlatformAccessories: vi.fn(),
    isMatterAvailable: vi.fn().mockReturnValue(Boolean(options.matterEnabled)),
    isMatterEnabled: vi.fn().mockReturnValue(Boolean(options.matterEnabled)),
    matter: matterMock,
    handlers,
  } as never
}

const log = Object.assign(vi.fn(), {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
}) as never

beforeEach(() => {
  vi.mocked(ZoneAccessory).mockImplementation(function (this: { dispose: () => void }) {
    this.dispose = vi.fn()
  } as never)
})

afterEach(() => {
  vi.mocked(ZoneAccessory).mockReset()
  vi.mocked(NeoMqtt).mockClear()
  vi.useRealTimers()
})

describe('actronAirNeoPlatform', () => {
  it.each([
    'rediscovery',
    'failed rebuild',
    'removal',
    'shutdown',
  ])('manages zone listeners on %s', async (action) => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo' } as never, api)
    const updated = vi.fn()
    vi.mocked(ZoneAccessory).mockImplementation(function (this: { dispose: () => void }, platform, _accessory, index) {
      this.dispose = platform.state.onChange(() => updated(index))
    } as never)
    let status = structuredClone(restStatus)
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => status,
    } as never)
    await p.discoverDevices()
    if (action === 'rediscovery') {
      await p.discoverDevices()
    }
    else if (action === 'failed rebuild') {
      vi.mocked(ZoneAccessory).mockImplementationOnce(class {
        constructor() {
          throw new Error('Transient wrapper failure')
        }
      } as never)
      await p.discoverDevices()
    }
    else if (action === 'removal') {
      status = structuredClone(restStatus)
      status.lastKnownState.RemoteZoneInfo[0].NV_Exists = false
      await p.discoverDevices()
    }
    else {
      api.handlers.shutdown()
    }
    updated.mockClear()
    p.state.applyDelta({ 'UserAirconSettings.isOn': !status.lastKnownState.UserAirconSettings.isOn })
    expect(updated.mock.calls.filter(([index]) => index === 0)).toHaveLength(['rediscovery', 'failed rebuild'].includes(action)
      ? 1
      : 0)
    api.handlers.shutdown()
  })

  it.each(['systems', 'status'])('abandons discovery when shutdown occurs during %s fetch', async (stage) => {
    vi.useFakeTimers()
    const api = makeApi({ matterEnabled: true })
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', refreshToken: 'rt' } as never, api)
    let release!: (value: unknown) => void
    const pending = new Promise((resolve) => {
      release = resolve
    })
    const getStatus = vi.fn(async () => stage === 'status'
      ? pending
      : restStatus)
    p.injectForTest({
      getSystems: async () => stage === 'systems'
        ? pending
        : systems,
      getStatus,
    } as never)
    const discovery = p.discoverDevices()
    await Promise.resolve()
    api.handlers.shutdown()
    release(stage === 'systems'
      ? systems
      : restStatus)
    await discovery
    expect(p.commands).toBeUndefined()
    expect(NeoMqtt).not.toHaveBeenCalled()
    expect(api.registerPlatformAccessories).not.toHaveBeenCalled()
    expect(api.matter.registerPlatformAccessories).not.toHaveBeenCalled()
    expect(api.matter.updatePlatformAccessories).not.toHaveBeenCalled()
    expect(api.matter.unregisterPlatformAccessories).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    if (stage === 'systems')
      expect(getStatus).not.toHaveBeenCalled()
  })

  it('does not start discovery or notify platform bindings after shutdown', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo' } as never, api)
    const getSystems = vi.fn(async () => systems)
    p.injectForTest({
      getSystems,
      getStatus: async () => restStatus,
    } as never)
    p.state.replace(restStatus.lastKnownState)
    const update = vi.fn()
    p.matterBindings.set('binding', {
      uuid: 'binding',
      accessory: { displayName: 'Binding' } as never,
      update,
    })
    api.handlers.shutdown()
    await p.discoverDevices()
    p.state.applyDelta({ 'UserAirconSettings.isOn': !restStatus.lastKnownState.UserAirconSettings.isOn })
    expect(getSystems).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
    expect(p.matterBindings.size).toBe(0)
  })

  it('logs config warnings at startup (e.g. a clamped refreshInterval)', () => {
    const api = makeApi()
    // eslint-disable-next-line no-new
    new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', refreshInterval: 2 } as never, api)
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/refreshInterval/))
  })

  it('skips a system with no last-known state when picking the account\'s first system', async () => {
    const { NeoNoStatusError } = await import('../src/neo/rest.js')
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    const twoSystems = {
      _embedded: {
        'ac-system': [
          { serial: 'dead01' },
          ...systems._embedded['ac-system'],
        ],
      },
    }
    const getStatus = vi.fn(async (serial: string) => {
      if (serial === 'dead01')
        throw new NeoNoStatusError(serial)
      return restStatus
    })
    p.injectForTest({
      getSystems: async () => twoSystems,
      getStatus,
    } as never)
    await p.discoverDevices()
    expect(p.serial).toBe(systems._embedded['ac-system'][0].serial)
    expect(api.registerPlatformAccessories).toHaveBeenCalled()
  })

  it('does not skip past a configured deviceSerial that has no last-known state', async () => {
    const { NeoNoStatusError } = await import('../src/neo/rest.js')
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, {
      platform: 'ActronAirNeo',
      name: 'x',
      refreshToken: 'rt',
      deviceSerial: 'dead01',
    } as never, api)
    const twoSystems = {
      _embedded: {
        'ac-system': [
          { serial: 'dead01' },
          ...systems._embedded['ac-system'],
        ],
      },
    }
    p.injectForTest({
      getSystems: async () => twoSystems,
      getStatus: vi.fn(async (serial: string) => {
        throw new NeoNoStatusError(serial)
      }),
    } as never)
    await p.discoverDevices()
    expect(p.serial).toBe('')
    expect(api.registerPlatformAccessories).not.toHaveBeenCalled()
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/dead01/))
  })

  it('does not register a brand-new accessory whose wrapper failed to build (it would publish empty)', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    vi.mocked(ZoneAccessory).mockImplementation(class {
      constructor() {
        throw new Error('boom')
      }
    } as never)
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => restStatus,
    } as never)
    await p.discoverDevices()
    const registered = api.registerPlatformAccessories.mock.calls.flatMap((call: unknown[]) => call[2] as { context: { device: { kind: string } } }[])
    expect(registered.length).toBeGreaterThan(0)
    expect(registered.some(a => a.context.device.kind === 'zone')).toBe(false)
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/Failed to initialize accessory/))
  })

  it('reports an account with no systems at all, keeping accessories', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    p.injectForTest({
      getSystems: async () => ({
        _embedded: { 'ac-system': [] },
      }),
      getStatus: vi.fn(),
    } as never)
    await p.discoverDevices()
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/No ActronAir systems found/))
    expect(api.unregisterPlatformAccessories).not.toHaveBeenCalled()
  })

  it('surfaces the no-status explanation when every system on the account is dead', async () => {
    const { NeoNoStatusError } = await import('../src/neo/rest.js')
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    p.injectForTest({
      getSystems: async () => ({
        _embedded: {
          'ac-system': [
            { serial: 'dead01' },
            { serial: 'dead02' },
          ],
        },
      }),
      getStatus: vi.fn(async (serial: string) => {
        throw new NeoNoStatusError(serial)
      }),
    } as never)
    await p.discoverDevices()
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/dead02 has no reported status/))
    expect(api.registerPlatformAccessories).not.toHaveBeenCalled()
  })

  it('stops scanning systems when shutdown arrives mid-scan', async () => {
    const { NeoNoStatusError } = await import('../src/neo/rest.js')
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    const getStatus = vi.fn(async (serial: string) => {
      api.handlers.shutdown()
      throw new NeoNoStatusError(serial)
    })
    p.injectForTest({
      getSystems: async () => ({
        _embedded: {
          'ac-system': [
            { serial: 'dead01' },
            { serial: 'live02' },
          ],
        },
      }),
      getStatus,
      close: vi.fn(),
    } as never)
    await p.discoverDevices()
    expect(getStatus).toHaveBeenCalledTimes(1)
    expect(p.serial).toBe('')
  })

  it.each([
    [
      'throws',
      () => {
        throw new Error('sync boom')
      },
      /sync boom/,
    ],
    [
      'rejects',
      () => Promise.reject(new Error('async boom')),
      /async boom/,
    ],
  ])('logs (never throws) when a Matter binding update %s', async (_label, update, message) => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x' } as never, api)
    p.matterBindings.set('u', {
      uuid: 'u',
      accessory: { displayName: 'Thermo' },
      update: vi.fn(update),
    } as never)
    expect(() => p.state.replace(restStatus.lastKnownState)).not.toThrow()
    await vi.waitFor(() => expect(log.error).toHaveBeenCalledWith(expect.stringMatching(message)))
  })

  it('does not start when no account is linked', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x' } as never, api)
    await p.discoverDevices()
    expect(api.registerPlatformAccessories).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/link your account/i))
  })

  it('registers master, mode switches and one accessory per existing zone', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => restStatus,
    } as never)

    await p.discoverDevices()

    const zoneCount = restStatus.lastKnownState.RemoteZoneInfo.filter((z: { NV_Exists?: boolean }) => z.NV_Exists).length
    expect(api.registerPlatformAccessories).toHaveBeenCalledTimes(1 + 3 + 1 + zoneCount)
  })

  it('never unregisters when discovery fails', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    p.configureAccessory({ UUID: 'uuid-stale', displayName: 'Old Zone', context: {} } as never)
    p.injectForTest({
      getSystems: async () => { throw new Error('cloud down') },
      getStatus: async () => restStatus,
    } as never)

    await p.discoverDevices()
    expect(api.unregisterPlatformAccessories).not.toHaveBeenCalled()
  })

  it('unregisters a genuinely stale cached accessory after a successful discovery', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    const stale = { UUID: 'uuid-not-in-discovery', displayName: 'Old Zone', context: {} } as never
    p.configureAccessory(stale)
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => restStatus,
    } as never)

    await p.discoverDevices()

    expect(api.unregisterPlatformAccessories).toHaveBeenCalledTimes(1)
    expect(api.unregisterPlatformAccessories).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      [stale],
    )
  })

  it('fixes a stale service name but leaves a service that names itself off the accessory alone', async () => {
    // The fan-only service is called "<accessory> Fan" on purpose (see MasterAccessory).
    // Reconciling it to the bare display name left two identically-named tiles in the Home app.
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'ActronAir Neo', refreshToken: 'rt' } as never, api)
    const makeService = (name: string) => {
      const service = {
        name,
        testCharacteristic: () => true,
        getCharacteristic: () => ({
          get value() { return service.name },
        }),
        updateCharacteristic: (_id: unknown, value: string) => { service.name = value },
      }
      return service
    }
    const stale = makeService('Old Name')
    const fan = makeService('ActronAir Neo Fan')
    // Left over from a longer previous displayName. A prefix test would exempt this one too,
    // which is the drift the reconcile exists to fix.
    const staleLonger = makeService('ActronAir Neo Upstairs')
    p.configureAccessory({
      UUID: `uuid-${systems._embedded['ac-system'][0].serial}`,
      displayName: 'ActronAir Neo',
      context: {},
      services: [stale, fan, staleLonger],
    } as never)
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => restStatus,
    } as never)

    await p.discoverDevices()

    expect(stale.name).toBe('ActronAir Neo')
    expect(staleLonger.name).toBe('ActronAir Neo')
    expect(fan.name).toBe('ActronAir Neo Fan')
  })

  it('does not extend the filter-name exemption to accessories that own no filter service', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    const zone0 = restStatus.lastKnownState.RemoteZoneInfo[0]
    const service = {
      name: `${zone0.NV_Title} Filter`,
      testCharacteristic: () => true,
      getCharacteristic: () => ({
        get value() { return service.name },
      }),
      updateCharacteristic: (_id: unknown, value: string) => { service.name = value },
    }
    p.configureAccessory({
      UUID: 'uuid-zone-0',
      displayName: zone0.NV_Title,
      context: {
        device: { kind: 'zone', zoneIndex: 0, id: 'zone-0' },
      },
      services: [service],
    } as never)
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => restStatus,
    } as never)

    await p.discoverDevices()

    expect(service.name).toBe(zone0.NV_Title)
  })

  it('does not extend the fan-name exemption to accessories that own no fan service', async () => {
    // A zone renamed "Study Fan" → "Study" leaves its sub-services cached as "Study Fan".
    // Only the master accessory has a service legitimately named "<name> Fan".
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    const zone0 = restStatus.lastKnownState.RemoteZoneInfo[0]
    const service = {
      name: `${zone0.NV_Title} Fan`,
      testCharacteristic: () => true,
      getCharacteristic: () => ({
        get value() { return service.name },
      }),
      updateCharacteristic: (_id: unknown, value: string) => { service.name = value },
    }
    p.configureAccessory({
      UUID: 'uuid-zone-0',
      displayName: zone0.NV_Title,
      context: {
        device: { kind: 'zone', zoneIndex: 0, id: 'zone-0' },
      },
      services: [service],
    } as never)
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => restStatus,
    } as never)

    await p.discoverDevices()

    expect(service.name).toBe(zone0.NV_Title)
  })

  it('does not duplicate accessories on a second discovery', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => restStatus,
    } as never)

    await p.discoverDevices()
    const firstRunCalls = api.registerPlatformAccessories.mock.calls.length

    await p.discoverDevices()

    expect(api.registerPlatformAccessories).toHaveBeenCalledTimes(firstRunCalls)
    expect(api.unregisterPlatformAccessories).not.toHaveBeenCalled()
  })

  it('logs and continues when one accessory fails to construct, so the others still register', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => restStatus,
    } as never)

    vi.mocked(ZoneAccessory).mockImplementationOnce(class {
      constructor() {
        throw new Error('bad characteristic range')
      }
    } as never)

    await expect(p.discoverDevices()).resolves.toBeUndefined()

    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/failed to initialize accessory/i))
    const zoneCount = restStatus.lastKnownState.RemoteZoneInfo.filter((z: { NV_Exists?: boolean }) => z.NV_Exists).length
    // The broken (new) accessory is not registered, since it would publish an empty tile, and
    // its failure does not stop the other 1 + 3 + 1 + (zoneCount - 1) siblings from registering.
    expect(api.registerPlatformAccessories).toHaveBeenCalledTimes(1 + 3 + 1 + zoneCount - 1)
  })

  it('logs and skips when two discovered devices collide on the same identity', async () => {
    const api = makeApi()
    api.hap.uuid.generate = () => 'uuid-collision'
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => restStatus,
    } as never)

    await p.discoverDevices()

    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/same identity/i))
    expect(api.registerPlatformAccessories).toHaveBeenCalledTimes(1)
  })

  it('does not register an outdoor temperature accessory when the reading is unusable (real fixture: sentinel + sensor error)', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => restStatus,
    } as never)

    await p.discoverDevices()

    const zoneCount = restStatus.lastKnownState.RemoteZoneInfo.filter((z: { NV_Exists?: boolean }) => z.NV_Exists).length
    // 1 master + 3 mode switches + zones, no outdoor sensor — matches the owner's real hardware.
    expect(api.registerPlatformAccessories).toHaveBeenCalledTimes(1 + 3 + 1 + zoneCount)
  })

  it('registers an outdoor temperature accessory when the reading is valid', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    const validOutdoorStatus = {
      ...restStatus,
      lastKnownState: {
        ...restStatus.lastKnownState,
        MasterInfo: { ...restStatus.lastKnownState.MasterInfo, LiveOutdoorTemp_oC: 18 },
        LiveAircon: {
          ...restStatus.lastKnownState.LiveAircon,
          OutdoorUnit: { ...restStatus.lastKnownState.LiveAircon.OutdoorUnit, AmbientSensErr: false },
        },
      },
    }
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => validOutdoorStatus,
    } as never)

    await p.discoverDevices()

    const zoneCount = restStatus.lastKnownState.RemoteZoneInfo.filter((z: { NV_Exists?: boolean }) => z.NV_Exists).length
    // 1 master + 3 mode switches + 1 after-hours + 1 outdoor temp + zones.
    expect(api.registerPlatformAccessories).toHaveBeenCalledTimes(1 + 3 + 1 + 1 + zoneCount)
  })

  it('does not register a turbo accessory when the unit does not report support (real fixture: Supported false)', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => restStatus,
    } as never)

    await p.discoverDevices()

    const zoneCount = restStatus.lastKnownState.RemoteZoneInfo.filter((z: { NV_Exists?: boolean }) => z.NV_Exists).length
    // 1 master + 3 mode switches + 1 after-hours + zones, no turbo — matches the owner's
    // real hardware (UserAirconSettings.TurboMode.Supported === false).
    expect(api.registerPlatformAccessories).toHaveBeenCalledTimes(1 + 3 + 1 + zoneCount)
  })

  it('registers a turbo accessory when the unit reports support', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    const turboSupportedStatus = {
      ...restStatus,
      lastKnownState: {
        ...restStatus.lastKnownState,
        UserAirconSettings: {
          ...restStatus.lastKnownState.UserAirconSettings,
          TurboMode: { Supported: true, Enabled: false },
        },
      },
    }
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => turboSupportedStatus,
    } as never)

    await p.discoverDevices()

    const zoneCount = restStatus.lastKnownState.RemoteZoneInfo.filter((z: { NV_Exists?: boolean }) => z.NV_Exists).length
    expect(api.registerPlatformAccessories).toHaveBeenCalledTimes(1 + 3 + 1 + 1 + zoneCount)
  })

  it('does not register a quiet mode switch when the unit does not report QuietModeEnabled', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    const noQuietStatus = {
      ...restStatus,
      lastKnownState: {
        ...restStatus.lastKnownState,
        UserAirconSettings: { ...restStatus.lastKnownState.UserAirconSettings, QuietModeEnabled: false },
      },
    }
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => noQuietStatus,
    } as never)

    await p.discoverDevices()

    const zoneCount = restStatus.lastKnownState.RemoteZoneInfo.filter((z: { NV_Exists?: boolean }) => z.NV_Exists).length
    // 1 master + away + continuousFan (no quiet) + 1 after-hours + zones.
    expect(api.registerPlatformAccessories).toHaveBeenCalledTimes(1 + 2 + 1 + zoneCount)
  })

  it('derives capabilities once after the first successful status fetch and logs the detected model', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => restStatus,
    } as never)

    await p.discoverDevices()

    expect(p.capabilities?.model).toBe('NTW-1000')
    expect(p.capabilities?.fanSpeeds).toEqual(['LOW', 'MED', 'HIGH'])
    expect(log.info).toHaveBeenCalledWith(expect.stringMatching(/Detected NTW-1000/))
  })

  it('clears the poll timer on shutdown', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => restStatus,
    } as never)
    await p.discoverDevices()

    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    api.handlers.shutdown()
    expect(clearSpy).toHaveBeenCalled()
    clearSpy.mockRestore()
  })

  it('polls on the configured interval, refreshing state and enabled zones', async () => {
    vi.useFakeTimers()
    const api = makeApi()
    const p = new ActronAirNeoPlatform(
      log,
      {
        platform: 'ActronAirNeo',
        name: 'x',
        refreshToken: 'rt',
        refreshInterval: 10,
      } as never,
      api,
    )
    const getStatus = vi.fn(async () => restStatus)
    p.injectForTest({
      getSystems: async () => systems,
      getStatus,
    } as never)

    await p.discoverDevices()
    getStatus.mockClear()
    const syncSpy = vi.spyOn(p.commands, 'syncEnabledZones')

    await vi.advanceTimersByTimeAsync(10_000)

    expect(getStatus).toHaveBeenCalledWith(systems._embedded['ac-system'][0].serial)
    expect(syncSpy).toHaveBeenCalled()
  })

  it('retries discovery on poll() after a failed initial discovery, recovering without a restart', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    let failDiscovery = true
    p.injectForTest({
      getSystems: async () => {
        if (failDiscovery)
          throw new Error('cloud down')
        return systems
      },
      getStatus: async () => restStatus,
    } as never)

    await p.discoverDevices()
    // Failed discovery leaves serial unset and commands never constructed — poll() must not
    // be permanently inert against this.
    expect(p.serial).toBe('')
    expect(api.registerPlatformAccessories).not.toHaveBeenCalled()

    failDiscovery = false
    await p.poll()

    expect(p.serial).not.toBe('')
    expect(p.commands).toBeDefined()
    expect(api.registerPlatformAccessories).toHaveBeenCalled()
  })

  it('does not run an overlapping poll while one is still in flight', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => restStatus,
    } as never)
    await p.discoverDevices()

    let releaseStatus: (() => void) | undefined
    const slowGetStatus = vi.fn(() => new Promise((resolve) => {
      releaseStatus = () => resolve(restStatus)
    }))
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: slowGetStatus,
    } as never)

    const first = p.poll()
    const second = p.poll() // must be a no-op skip, not a second overlapping request

    releaseStatus!()
    await Promise.all([first, second])

    expect(slowGetStatus).toHaveBeenCalledTimes(1)
  })

  it('clears cloudConnected when a poll fails, so the accessory comms guard means something', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => restStatus,
    } as never)
    await p.discoverDevices()
    expect(p.state.cloudConnected).toBe(true)

    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => { throw new Error('cloud down') },
    } as never)

    await p.poll()

    expect(p.state.cloudConnected).toBe(false)
  })

  it('migrates a zone accessory cached under the old index-plus-title identity to the new index-only scheme, keeping the same accessory', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)

    const zone0 = restStatus.lastKnownState.RemoteZoneInfo[0]
    const oldUuid = `uuid-zone-0-${zone0.NV_Title}`
    const cached = {
      UUID: oldUuid,
      displayName: zone0.NV_Title,
      context: {
        device: { kind: 'zone', zoneIndex: 0, id: `zone-0-${zone0.NV_Title}` },
      },
    }
    p.configureAccessory(cached as never)

    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => restStatus,
    } as never)

    await p.discoverDevices()

    // Not treated as stale — the migrated accessory keeps its old UUID rather than being
    // unregistered and replaced by a freshly generated one.
    expect(api.unregisterPlatformAccessories).not.toHaveBeenCalled()
    expect(log.info).toHaveBeenCalledWith(expect.stringMatching(/migrating zone/i))
    expect(p.accessories).toContain(cached)
  })

  it('renaming a zone in the source data does not change its accessory identity', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => restStatus,
    } as never)
    await p.discoverDevices()
    const zone0Accessory = p.accessories.find(a => (a.context.device as { kind?: string, zoneIndex?: number } | undefined)?.kind === 'zone' && (a.context.device as { zoneIndex?: number }).zoneIndex === 0)
    expect(zone0Accessory).toBeDefined()
    const uuidBeforeRename = zone0Accessory!.UUID

    const renamed = {
      ...restStatus,
      lastKnownState: {
        ...restStatus.lastKnownState,
        RemoteZoneInfo: restStatus.lastKnownState.RemoteZoneInfo.map((z: { NV_Title?: string }, i: number) =>
          i === 0
            ? { ...z, NV_Title: 'Totally Renamed Zone' }
            : z),
      },
    }
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => renamed,
    } as never)
    await p.discoverDevices()

    const zone0AfterRename = p.accessories.find(a => (a.context.device as { kind?: string, zoneIndex?: number } | undefined)?.kind === 'zone' && (a.context.device as { zoneIndex?: number }).zoneIndex === 0)
    expect(zone0AfterRename!.UUID).toBe(uuidBeforeRename)
    expect(api.unregisterPlatformAccessories).not.toHaveBeenCalled()
  })

  it('connects MQTT push after a successful discovery, by default', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => restStatus,
      getConnectionDetails: vi.fn(),
    } as never)

    await p.discoverDevices()

    expect(NeoMqtt).toHaveBeenCalledTimes(1)
    expect(vi.mocked(NeoMqtt).mock.results[0].value.start).toHaveBeenCalled()
  })

  it('disconnects MQTT push on shutdown', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => restStatus,
      getConnectionDetails: vi.fn(),
    } as never)
    await p.discoverDevices()
    const instance = vi.mocked(NeoMqtt).mock.results[0].value

    api.handlers.shutdown()

    expect(instance.stop).toHaveBeenCalled()
  })

  it('a failed discovery never starts MQTT push and leaves REST polling running', async () => {
    vi.useFakeTimers()
    const api = makeApi()
    const p = new ActronAirNeoPlatform(
      log,
      {
        platform: 'ActronAirNeo',
        name: 'x',
        refreshToken: 'rt',
        refreshInterval: 10,
      } as never,
      api,
    )
    const getSystems = vi.fn(async () => {
      throw new Error('cloud down')
    })
    p.injectForTest({
      getSystems,
      getStatus: async () => restStatus,
      getConnectionDetails: vi.fn(),
    } as never)

    await p.discoverDevices()
    expect(NeoMqtt).not.toHaveBeenCalled()

    getSystems.mockClear()
    await vi.advanceTimersByTimeAsync(10_000)
    // The scheduled poll retried discovery — polling did not stop because push never started.
    expect(getSystems).toHaveBeenCalled()
  })

  it('widens the poll interval to the push-healthy cadence the instant push reports healthy', async () => {
    vi.useFakeTimers()
    const api = makeApi()
    const p = new ActronAirNeoPlatform(
      log,
      {
        platform: 'ActronAirNeo',
        name: 'x',
        refreshToken: 'rt',
        refreshInterval: 10,
      } as never,
      api,
    )
    const getStatus = vi.fn(async () => restStatus)
    p.injectForTest({
      getSystems: async () => systems,
      getStatus,
      getConnectionDetails: vi.fn(),
    } as never)

    await p.discoverDevices()
    const instance = vi.mocked(NeoMqtt).mock.results[0].value as { healthy: boolean, opts: { onHealthChange: (h: boolean) => void } }
    getStatus.mockClear()

    instance.healthy = true
    instance.opts.onHealthChange(true)

    // Push reports healthy — the configured 10s interval must no longer drive polling.
    await vi.advanceTimersByTimeAsync(40_000)
    expect(getStatus).not.toHaveBeenCalled()

    // Only the 5-minute safety-net cadence fires while push stays healthy.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 40_000)
    expect(getStatus).toHaveBeenCalled()
  })

  it('narrows the poll interval back immediately the instant push reports stale/down, without waiting out the wide interval', async () => {
    vi.useFakeTimers()
    const api = makeApi()
    const p = new ActronAirNeoPlatform(
      log,
      {
        platform: 'ActronAirNeo',
        name: 'x',
        refreshToken: 'rt',
        refreshInterval: 10,
      } as never,
      api,
    )
    const getStatus = vi.fn(async () => restStatus)
    p.injectForTest({
      getSystems: async () => systems,
      getStatus,
      getConnectionDetails: vi.fn(),
    } as never)

    await p.discoverDevices()
    const instance = vi.mocked(NeoMqtt).mock.results[0].value as { healthy: boolean, opts: { onHealthChange: (h: boolean) => void } }
    instance.healthy = true
    instance.opts.onHealthChange(true) // widen to the 5-minute safety-net cadence

    getStatus.mockClear()
    instance.healthy = false
    instance.opts.onHealthChange(false) // push just went stale/down — narrow back now, not in 5 minutes

    await vi.advanceTimersByTimeAsync(10_000)
    expect(getStatus).toHaveBeenCalled()
  })

  it('does not resurrect the poll timer if shutdown fires while a poll is already in flight', async () => {
    vi.useFakeTimers()
    const api = makeApi()
    const p = new ActronAirNeoPlatform(
      log,
      {
        platform: 'ActronAirNeo',
        name: 'x',
        refreshToken: 'rt',
        refreshInterval: 10,
      } as never,
      api,
    )
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => restStatus,
      getConnectionDetails: vi.fn(),
    } as never)
    await p.discoverDevices()

    let releaseStatus: (() => void) | undefined
    const slowGetStatus = vi.fn(() => new Promise((resolve) => {
      releaseStatus = () => resolve(restStatus)
    }))
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: slowGetStatus,
      getConnectionDetails: vi.fn(),
    } as never)

    await vi.advanceTimersByTimeAsync(10_000) // fires the scheduled poll; it's now in flight, blocked on releaseStatus
    expect(slowGetStatus).toHaveBeenCalledTimes(1)

    api.handlers.shutdown() // shutdown while that poll is still in flight
    releaseStatus!()
    await vi.advanceTimersByTimeAsync(0) // let poll()'s .finally(() => this.startPolling()) run

    slowGetStatus.mockClear()
    await vi.advanceTimersByTimeAsync(35_000)
    // startPolling() must have refused to reschedule after shutdown — no further polls.
    expect(slowGetStatus).not.toHaveBeenCalled()
  })
  it('reconciles CommandQueue.enabledZones from a push update, not only from a poll', async () => {
    // With push healthy the poll widens to 5 minutes, so a zone the user disabled in the
    // ActronAir app would stay "on" in the queue's local array for that whole window — and
    // the next HomeKit zone toggle, which always sends the complete array, would silently
    // turn it back on.
    const api = makeApi()
    const p = new ActronAirNeoPlatform(
      log,
      { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never,
      api,
    )
    const sendCommand = vi.fn(async () => ({ type: 'ack' }))
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => restStatus,
      sendCommand,
    } as never)
    await p.discoverDevices()

    // Zone 0 disabled elsewhere; only MQTT sees it (no poll runs in between).
    const pushed = restStatus.lastKnownState.UserAirconSettings.EnabledZones.map((on: boolean, i: number) => i === 0
      ? false
      : on)
    p.state.applyDelta({ 'UserAirconSettings.EnabledZones': pushed })

    await p.commands.run(NeoCommand.ZONE_ENABLE, { zoneIndex: 1 })

    const expected = [...pushed]
    expected[1] = true
    expect(sendCommand).toHaveBeenCalledWith(
      systems._embedded['ac-system'][0].serial,
      {
        command: { 'UserAirconSettings.EnabledZones': expected, 'type': 'set-settings' },
      },
    )
  })

  it('logs a revoked account link from the poll loop at error, not debug', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => restStatus,
    } as never)
    await p.discoverDevices()

    log.error.mockClear()
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => { throw new NeoAuthRevokedError('invalid_grant') },
    } as never)
    await p.poll()

    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/link your account again/i))
  })

  it('logs the revoked account link once, not once per poll', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => restStatus,
    } as never)
    await p.discoverDevices()

    log.error.mockClear()
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => { throw new NeoAuthRevokedError('invalid_grant') },
    } as never)

    await p.poll()
    await p.poll()
    await p.poll()

    // The message is actionable exactly once; repeating it every 60s until the user re-links
    // is noise, not information.
    expect(log.error).toHaveBeenCalledTimes(1)
  })

  it('clears the failure counters once a poll recovers, so the next blip is quiet again', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    let fail = false
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => {
        if (fail)
          throw new Error('cloud down')
        return restStatus
      },
    } as never)
    await p.discoverDevices()

    fail = true
    await p.poll()
    await p.poll()
    await p.poll() // now past the warn threshold

    fail = false
    await p.poll() // recovered

    log.warn.mockClear()
    fail = true
    await p.poll() // a fresh single blip must be quiet again

    expect(log.warn).not.toHaveBeenCalled()
  })

  it('warns once repeated polls keep failing, instead of staying silent at debug forever', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => restStatus,
    } as never)
    await p.discoverDevices()

    log.warn.mockClear()
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => { throw new Error('cloud down') },
    } as never)

    await p.poll()
    expect(log.warn).not.toHaveBeenCalled() // a single blip stays quiet

    await p.poll()
    await p.poll()
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/cloud down/))
  })

  it('cancels debounced commands on shutdown rather than leaving them pending', async () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(
      log,
      { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never,
      api,
    )
    p.injectForTest({
      getSystems: async () => systems,
      getStatus: async () => restStatus,
      sendCommand: vi.fn(),
    } as never)
    await p.discoverDevices()

    const pending = p.commands.run(NeoCommand.ON)
    api.handlers.shutdown()

    await expect(pending).rejects.toThrow(/cancelled/i)
  })
  it('makes the debug config option real by routing log.debug to log.info', () => {
    // Homebridge gates log.debug on its own -D flag, so without this the documented option
    // produced byte-identical output. The wrapped logger is what every collaborator gets.
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', debug: true } as never, api)

    log.info.mockClear()
    p.log.debug('queued command')

    expect(log.info).toHaveBeenCalledWith('queued command')
  })

  it('leaves Homebridge\'s own debug behaviour alone when the option is off', () => {
    const api = makeApi()
    const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x' } as never, api)

    log.info.mockClear()
    log.debug.mockClear()
    p.log.debug('queued command')

    expect(log.debug).toHaveBeenCalledWith('queued command')
    expect(log.info).not.toHaveBeenCalled()
  })

  describe('matter integration', () => {
    it.each(['register', 'update'])('stops later Matter stages if shutdown happens during %s', async (stage) => {
      const api = makeApi({ matterEnabled: true })
      const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo' } as never, api)
      const cached = { UUID: 'matter-uuid-matter:neo000000', displayName: 'Master', context: {} } as never
      const stale = { UUID: 'stale', displayName: 'Removed', context: {} } as never
      p.configureMatterAccessory(cached)
      p.injectForTest({
        getSystems: async () => systems,
        getStatus: async () => restStatus,
      } as never)
      // Update only happens for accessories already registered this session, so reaching
      // that stage needs one completed discovery first.
      if (stage === 'update')
        await p.discoverDevices()
      p.configureMatterAccessory(stale)
      const operation = stage === 'register'
        ? api.matter.registerPlatformAccessories
        : api.matter.updatePlatformAccessories
      let release!: () => void
      operation.mockImplementationOnce(() => new Promise<void>((resolve) => {
        release = resolve
      }))
      const discovery = p.discoverDevices()
      await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce())
      const trackedBeforeShutdown = p.matterAccessories.size
      api.handlers.shutdown()
      release()
      await discovery
      if (stage === 'register')
        expect(api.matter.updatePlatformAccessories).not.toHaveBeenCalled()
      expect(p.matterAccessories.size).toBe(trackedBeforeShutdown)
      expect(p.matterBindings.size).toBe(0)
      expect(api.matter.unregisterPlatformAccessories).not.toHaveBeenCalled()
    })

    it('moves a restored thermostat from its cached limits to the new ones in writes matter.js accepts', async () => {
      // Homebridge keeps a restored endpoint's cached limit attributes. matter.js (ThermostatServer)
      // rejects a user-limit write outside the current absolute limits, and an absolute-limit write
      // that no longer nests the current user limits. These are the limits 1.3.2 could have cached:
      // heat capped at 26 and cool floored at 20, both narrower than this unit's 16-30.
      const cachedLimits = {
        absMinHeatSetpointLimit: 700,
        absMaxHeatSetpointLimit: 2600,
        minHeatSetpointLimit: 1000,
        maxHeatSetpointLimit: 2600,
        absMinCoolSetpointLimit: 2000,
        absMaxCoolSetpointLimit: 3200,
        minCoolSetpointLimit: 2000,
        maxCoolSetpointLimit: 3200,
      }
      const api = makeApi({ matterEnabled: true })
      const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
      p.configureMatterAccessory({
        UUID: 'matter-uuid-matter:neo000000',
        displayName: 'Old',
        context: {},
        clusters: {
          thermostat: { ...cachedLimits },
        },
      } as never)
      p.injectForTest({
        getSystems: async () => systems,
        getStatus: async () => restStatus,
      } as never)

      await p.discoverDevices()

      const writes = api.matter.updateAccessoryState.mock.calls
        .filter((call: unknown[]) => call[0] === 'matter-uuid-matter:neo000000' && call[1] === 'thermostat')
        .map((call: unknown[]) => call[2] as Record<string, number>)
      // Replay every write through matter.js's rules, starting from the cached state.
      const endpoint: Record<string, number> = { ...cachedLimits }
      for (const write of writes) {
        for (const [key, value] of Object.entries(write)) {
          const scope = key.includes('Heat')
            ? 'Heat'
            : 'Cool'
          if (/^(?:min|max)(?:Heat|Cool)SetpointLimit$/.test(key)) {
            expect(value, `${key} within current abs limits`).toBeGreaterThanOrEqual(endpoint[`absMin${scope}SetpointLimit`])
            expect(value, `${key} within current abs limits`).toBeLessThanOrEqual(endpoint[`absMax${scope}SetpointLimit`])
          }
          if (key.startsWith('absMin'))
            expect(value, `${key} nests current min`).toBeLessThanOrEqual(endpoint[`min${scope}SetpointLimit`])
          if (key.startsWith('absMax'))
            expect(value, `${key} nests current max`).toBeGreaterThanOrEqual(endpoint[`max${scope}SetpointLimit`])
          if (key === 'occupiedHeatingSetpoint' || key === 'occupiedCoolingSetpoint') {
            const s = key === 'occupiedHeatingSetpoint'
              ? 'Heat'
              : 'Cool'
            expect(value).toBeGreaterThanOrEqual(endpoint[`min${s}SetpointLimit`])
            expect(value).toBeLessThanOrEqual(endpoint[`max${s}SetpointLimit`])
          }
          endpoint[key] = value
        }
      }
      // The unit reports 16-30 for both modes: that is where the endpoint must end up.
      expect(endpoint).toMatchObject({
        minHeatSetpointLimit: 1600,
        maxHeatSetpointLimit: 3000,
        minCoolSetpointLimit: 1600,
        maxCoolSetpointLimit: 3000,
      })
      expect(writes.some(w => 'occupiedHeatingSetpoint' in w)).toBe(true)
    })

    it('moves an already-registered thermostat to new limits when the device reports a different range', async () => {
      // updatePlatformAccessories() merges metadata only; the live endpoint keeps the limits it
      // was registered with, so a rediscovery that finds a new NV_Limits range must move them.
      const api = makeApi({ matterEnabled: true })
      const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
      let status = restStatus
      p.injectForTest({
        getSystems: async () => systems,
        getStatus: async () => status,
      } as never)
      await p.discoverDevices()

      status = structuredClone(restStatus)
      Object.assign(status.lastKnownState.NV_Limits.UserSetpoint_oC, { setHeat_Max: 28, setCool_Min: 18 })
      api.matter.updateAccessoryState.mockClear()
      await p.discoverDevices()

      expect(api.matter.updatePlatformAccessories).toHaveBeenCalled()
      const userLimitWrite = api.matter.updateAccessoryState.mock.calls
        .find((call: unknown[]) => call[0] === 'matter-uuid-matter:neo000000' && 'maxHeatSetpointLimit' in (call[2] as object))
      expect(userLimitWrite?.[2]).toMatchObject({ maxHeatSetpointLimit: 2800, minCoolSetpointLimit: 1800 })
    })

    it('leaves a restored thermostat\'s limits alone when the cache already matches', async () => {
      const api = makeApi({ matterEnabled: true })
      const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
      const { thermostatLimits } = await import('../src/matter/thermostat.js')
      const current = thermostatLimits({ min: 16, max: 30 }, { min: 16, max: 30 }).attributes
      p.configureMatterAccessory({
        UUID: 'matter-uuid-matter:neo000000',
        displayName: 'Old',
        context: {},
        clusters: {
          thermostat: { ...current },
        },
      } as never)
      p.injectForTest({
        getSystems: async () => systems,
        getStatus: async () => restStatus,
      } as never)
      await p.discoverDevices()
      const limitWrites = api.matter.updateAccessoryState.mock.calls
        .filter((call: unknown[]) => call[0] === 'matter-uuid-matter:neo000000' && Object.keys(call[2] as object).some(k => k.endsWith('SetpointLimit')))
      expect(limitWrites).toHaveLength(0)
    })

    it('keeps stale Matter tracking after unregister failure so discovery can retry', async () => {
      const api = makeApi({ matterEnabled: true })
      const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo' } as never, api)
      const stale = { UUID: 'stale', displayName: 'Old Zone' } as never
      const binding = {
        uuid: 'stale',
        accessory: stale,
        update: vi.fn(),
      }
      p.configureMatterAccessory(stale)
      p.matterBindings.set('stale', binding)
      p.injectForTest({
        getSystems: async () => systems,
        getStatus: async () => restStatus,
      } as never)
      api.matter.unregisterPlatformAccessories.mockRejectedValueOnce(new Error('offline'))
      await p.discoverDevices()
      expect(p.matterAccessories.get('stale')).toBe(stale)
      expect(p.matterBindings.get('stale')).toBe(binding)
      await p.discoverDevices()
      expect(api.matter.unregisterPlatformAccessories).toHaveBeenCalledTimes(2)
      expect(p.matterAccessories.has('stale')).toBe(false)
      expect(p.matterBindings.has('stale')).toBe(false)
    })

    it('discards bindings for rejected new registrations', async () => {
      const api = makeApi({ matterEnabled: true })
      const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo' } as never, api)
      p.injectForTest({
        getSystems: async () => systems,
        getStatus: async () => restStatus,
      } as never)
      api.matter.registerPlatformAccessories.mockRejectedValue(new Error('offline'))
      await p.discoverDevices()
      expect(p.matterAccessories.size).toBe(0)
      expect(p.matterBindings.size).toBe(0)
    })

    it('detects disabled Matter when not available on bridge', () => {
      const api = makeApi({ matterEnabled: false })
      log.info.mockClear()
      const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x' } as never, api)
      expect(p.isMatterSupported).toBe(false)
      expect(log.info).toHaveBeenCalledWith('Matter support: disabled')
    })

    it('detects enabled Matter and registers discovered accessories', async () => {
      const api = makeApi({ matterEnabled: true })
      log.info.mockClear()
      const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
      expect(p.isMatterSupported).toBe(true)
      expect(log.info).toHaveBeenCalledWith('Matter support: enabled')

      p.injectForTest({
        getSystems: async () => systems,
        getStatus: async () => restStatus,
      } as never)

      await p.discoverDevices()

      expect(api.matter.registerPlatformAccessories).toHaveBeenCalledWith(
        'homebridge-actronair-neo',
        'ActronAirNeo',
        expect.any(Array),
      )
      expect(p.matterAccessories.size).toBeGreaterThan(0)
    })

    it('re-registers cached Matter accessories on the first sync so Homebridge attaches their handlers', async () => {
      // Homebridge restores cached Matter endpoints with stub handlers; only
      // registerPlatformAccessories() attaches the plugin's. update would leave every restored
      // accessory deaf to commands until it was removed and re-added.
      const api = makeApi({ matterEnabled: true })
      const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)

      const cachedMaster = {
        UUID: 'matter-uuid-matter:neo000000',
        displayName: 'Old Name',
        context: {},
      } as never
      p.configureMatterAccessory(cachedMaster)
      expect(p.matterAccessories.get('matter-uuid-matter:neo000000')).toBe(cachedMaster)

      p.injectForTest({
        getSystems: async () => systems,
        getStatus: async () => restStatus,
      } as never)

      await p.discoverDevices()

      const registered = api.matter.registerPlatformAccessories.mock.calls.flatMap((call: unknown[]) => call[2] as { UUID: string }[])
      expect(registered.map(a => a.UUID)).toContain('matter-uuid-matter:neo000000')
      expect(api.matter.updatePlatformAccessories).not.toHaveBeenCalled()

      // Homebridge keeps a restored endpoint's cached cluster values (api.d.ts: "To set the
      // current state of a restored accessory, call updateAccessoryState() once this promise
      // resolves"), so the binding must push the live state right after re-registration.
      expect(api.matter.updateAccessoryState.mock.calls.some((call: unknown[]) => call[0] === 'matter-uuid-matter:neo000000')).toBe(true)

      // A later rediscovery in the same session updates rather than re-registers.
      api.matter.registerPlatformAccessories.mockClear()
      await p.discoverDevices()
      expect(api.matter.registerPlatformAccessories).not.toHaveBeenCalled()
      expect(api.matter.updatePlatformAccessories).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ UUID: 'matter-uuid-matter:neo000000' }),
        ]),
      )
    })

    it('unregisters stale Matter accessories no longer present', async () => {
      const api = makeApi({ matterEnabled: true })
      const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)

      const stale = {
        UUID: 'matter-uuid-matter:stale-device',
        displayName: 'Removed Zone',
        context: {},
      } as never
      p.configureMatterAccessory(stale)

      p.injectForTest({
        getSystems: async () => systems,
        getStatus: async () => restStatus,
      } as never)

      await p.discoverDevices()

      expect(api.matter.unregisterPlatformAccessories).toHaveBeenCalledWith(
        'homebridge-actronair-neo',
        'ActronAirNeo',
        [stale],
      )
      expect(p.matterAccessories.has('matter-uuid-matter:stale-device')).toBe(false)
    })

    it('isolates Matter failures so HAP accessories still register', async () => {
      const api = makeApi({ matterEnabled: true })
      api.matter.registerPlatformAccessories.mockRejectedValue(new Error('Matter daemon crashed'))

      const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
      p.injectForTest({
        getSystems: async () => systems,
        getStatus: async () => restStatus,
      } as never)

      await p.discoverDevices()

      // HAP accessories were registered despite Matter error
      expect(api.registerPlatformAccessories).toHaveBeenCalled()
      expect(log.error).toHaveBeenCalledWith('Failed to register Matter accessories: Matter daemon crashed')
    })

    it('catches async errors thrown in matterBindings update during state changes', async () => {
      const api = makeApi({ matterEnabled: true })
      const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)
      p.state.replace(restStatus.lastKnownState as never)

      const rejectedBinding = {
        uuid: 'test-uuid',
        accessory: { displayName: 'Async Failing Accessory' },
        update: vi.fn().mockRejectedValue(new Error('Async update explosion')),
      }
      p.matterBindings.set('test-uuid', rejectedBinding as never)

      log.error.mockClear()
      p.state.applyDelta({ 'UserAirconSettings.isOn': true })
      await new Promise(r => setTimeout(r, 0))

      expect(log.error).toHaveBeenCalledWith('Failed to update Matter accessory "Async Failing Accessory": Async update explosion')
    })

    it('does not unregister cached Matter accessories when build throws for a discovered device', async () => {
      const api = makeApi({ matterEnabled: true })
      const p = new ActronAirNeoPlatform(log, { platform: 'ActronAirNeo', name: 'x', refreshToken: 'rt' } as never, api)

      const cachedMaster = {
        UUID: 'matter-uuid-matter:neo000000',
        displayName: 'ActronAir Neo',
        context: {},
      } as never
      p.configureMatterAccessory(cachedMaster)

      p.injectForTest({
        getSystems: async () => systems,
        getStatus: async () => restStatus,
      } as never)

      const mapping = await import('../src/matter/mapping.js')
      const spy = vi.spyOn(mapping, 'buildMatterAccessory').mockImplementation(() => {
        throw new Error('Transient build error')
      })

      try {
        await p.discoverDevices()
      }
      finally {
        expect(spy).toHaveBeenCalled()
        spy.mockRestore()
      }

      expect(api.matter.registerPlatformAccessories).not.toHaveBeenCalled()
      expect(api.matter.updatePlatformAccessories).not.toHaveBeenCalled()
      // Cached accessory must NOT be unregistered because its identity was reserved in wanted
      expect(api.matter.unregisterPlatformAccessories).not.toHaveBeenCalled()
      expect(p.matterAccessories.has('matter-uuid-matter:neo000000')).toBe(true)
    })
  })
})

describe('sanitizeAccessoryName', () => {
  // HAP warns that a name not starting and ending with a letter or number "may prevent the
  // accessory from being added in the Home App or cause unresponsiveness". Zone names are
  // whatever the user typed in the ActronAir app, where a trailing space is invisible.
  it('trims edge characters HAP rejects', () => {
    expect(sanitizeAccessoryName('Office 1 ', 'Zone 3')).toBe('Office 1')
    expect(sanitizeAccessoryName('  Master Bedroom  ', 'Zone 1')).toBe('Master Bedroom')
  })

  it('leaves a name HAP already accepts untouched, including interior punctuation', () => {
    expect(sanitizeAccessoryName('Office 1', 'Zone 3')).toBe('Office 1')
    expect(sanitizeAccessoryName('Kids\' Room', 'Zone 2')).toBe('Kids\' Room')
    expect(sanitizeAccessoryName('Zone-A', 'Zone 8')).toBe('Zone-A')
  })

  it('keeps non-ASCII letters, which are valid and common in room names', () => {
    expect(sanitizeAccessoryName('Café', 'Zone 9')).toBe('Café')
  })

  it('falls back when nothing usable survives, rather than naming an accessory ""', () => {
    expect(sanitizeAccessoryName('...', 'Zone 5')).toBe('Zone 5')
    expect(sanitizeAccessoryName('', 'Zone 6')).toBe('Zone 6')
    expect(sanitizeAccessoryName('   ', 'Zone 7')).toBe('Zone 7')
  })
})
