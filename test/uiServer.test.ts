import { afterEach, describe, expect, it, vi } from 'vitest'

// The real HomebridgePluginUiServer base class calls process.exit(1) in its constructor
// when not run as an IPC child (which is always true under a test runner), and wires up
// IPC message handlers that don't apply here. Stub it so importing homebridge-ui/server.js
// exercises only the plugin's own request handlers.
vi.mock('@homebridge/plugin-ui-utils', () => ({
  HomebridgePluginUiServer: class {
    onRequest(): void {}
    ready(): void {}
  },
}))

const DEVICE_CODE = {
  device_code: 'dc',
  user_code: 'ABCD-1234',
  verification_uri: 'https://nimbus.actronair.com.au/device',
  verification_uri_complete: 'https://nimbus.actronair.com.au/device?code=ABCD-1234',
  expires_in: 600,
  interval: 5,
}

function stubDeviceCode(body: Record<string, unknown>): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })))
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('homebridge-ui server', () => {
  it.each([400, 401])('classifies OAuth HTTP %s as an invalid link', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status })))
    const { default: server } = await import('../homebridge-ui/server.js')
    await expect(server.session({ refreshToken: 'rt' })).resolves.toEqual({ state: 'invalid' })
  })

  it.each([403, 429, 503])('keeps the account link on transient HTTP %s', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status })))
    const { default: server } = await import('../homebridge-ui/server.js')
    // Rejections already reach the browser's showCloudError retry view.
    await expect(server.session({ refreshToken: 'rt' })).rejects.toThrow(/try again/i)
  })

  it('attaches an abort signal to the token-exchange fetch so a hung connection cannot block the settings UI forever', async () => {
    let seenSignal: AbortSignal | undefined
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      seenSignal = init.signal as AbortSignal
      return new Response(JSON.stringify(DEVICE_CODE), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchImpl)

    const { default: server } = await import('../homebridge-ui/server.js')
    await server.requestDeviceCode('client-1')

    expect(fetchImpl).toHaveBeenCalled()
    expect(seenSignal).toBeInstanceOf(AbortSignal)
  })

  it('attaches an abort signal to both account-lookup fetches', async () => {
    const seenSignals: (AbortSignal | undefined)[] = []
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      seenSignals.push(init.signal as AbortSignal | undefined)
      return new Response(JSON.stringify({
        email: 'x@example.com',
        _embedded: { 'ac-system': [] },
      }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchImpl)

    const { default: server } = await import('../homebridge-ui/server.js')
    await server.account({ accessToken: 'tok' })

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(seenSignals).toHaveLength(2)
    for (const signal of seenSignals)
      expect(signal).toBeInstanceOf(AbortSignal)
  })
  it('surfaces a cloud failure instead of reporting an empty system list', async () => {
    // A 429/5xx (or an HTML error body) parses to `undefined._embedded`, which a bare `?? []`
    // turned into "✅ Linked as <email>" with an empty dropdown and nothing logged.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>rate limited</html>', { status: 429 })))

    const { default: server } = await import('../homebridge-ui/server.js')

    await expect(server.account({ accessToken: 'tok' })).rejects.toThrow(/could not reach the actronair cloud/i)
  })

  it('surfaces an unreadable 200 response rather than an empty system list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>not json</html>', { status: 200 })))

    const { default: server } = await import('../homebridge-ui/server.js')

    await expect(server.account({ accessToken: 'tok' })).rejects.toThrow(/unreadable/i)
  })

  describe('device-code response validation', () => {
    it('passes a well-formed response through', async () => {
      stubDeviceCode(DEVICE_CODE)
      const { default: server } = await import('../homebridge-ui/server.js')
      await expect(server.requestDeviceCode('client-1')).resolves.toEqual(DEVICE_CODE)
    })

    it.each([
      ['javascript:', 'javascript:alert(1)'],
      ['plain http', 'http://nimbus.actronair.com.au/device'],
      ['unparseable', 'not a url'],
    ])('rejects a %s verification URI so it can never become a clickable link', async (_label, uri) => {
      stubDeviceCode({ ...DEVICE_CODE, verification_uri: uri, verification_uri_complete: undefined })
      const { default: server } = await import('../homebridge-ui/server.js')
      await expect(server.requestDeviceCode('client-1')).rejects.toThrow(/unexpected response/i)
    })

    it('drops a non-https verification_uri_complete but keeps a valid verification_uri', async () => {
      stubDeviceCode({ ...DEVICE_CODE, verification_uri_complete: 'javascript:alert(1)' })
      const { default: server } = await import('../homebridge-ui/server.js')
      const code = await server.requestDeviceCode('client-1')
      expect(code.verification_uri_complete).toBeUndefined()
      expect(code.verification_uri).toBe(DEVICE_CODE.verification_uri)
    })

    it.each([
      ['missing', undefined, 5],
      ['zero', 0, 5],
      ['non-numeric', 'fast', 5],
      ['too small', 1, 5],
      ['larger than default', 10, 10],
    ])('normalises a %s polling interval (RFC 8628 default 5s) so the browser never polls in a hot loop', async (_label, interval, expected) => {
      stubDeviceCode({ ...DEVICE_CODE, interval })
      const { default: server } = await import('../homebridge-ui/server.js')
      await expect(server.requestDeviceCode('client-1')).resolves.toMatchObject({ interval: expected })
    })

    it.each([
      [
        'device_code',
        { device_code: '' },
      ],
      [
        'user_code',
        { user_code: undefined },
      ],
      [
        'expires_in',
        { expires_in: 0 },
      ],
    ])('rejects a response with an unusable %s', async (_label, patch) => {
      stubDeviceCode({
        ...DEVICE_CODE,
        ...patch,
      })
      const { default: server } = await import('../homebridge-ui/server.js')
      await expect(server.requestDeviceCode('client-1')).rejects.toThrow(/unexpected response/i)
    })
  })

  describe('request parameter validation', () => {
    it.each([
      [
        'pollToken',
        (s: any) => s.pollToken({ deviceCode: 42 }),
      ],
      [
        'pollToken',
        (s: any) => s.pollToken({}),
      ],
      [
        'session',
        (s: any) => s.session({ refreshToken: '' }),
      ],
      [
        'session',
        (s: any) => s.session({
          refreshToken: { $gt: '' },
        }),
      ],
      [
        'account',
        (s: any) => s.account({
          accessToken: ['a'],
        }),
      ],
      [
        'account',
        (s: any) => s.account({ accessToken: 'tok\r\nX-Injected: 1' }),
      ],
      [
        'requestDeviceCode',
        (s: any) => s.requestDeviceCode(123),
      ],
      [
        'pollToken',
        (s: any) => s.pollToken({ deviceCode: 'dc', clientId: '' }),
      ],
    ])('%s rejects a malformed parameter without calling the cloud', async (_name, call) => {
      const fetchImpl = vi.fn()
      vi.stubGlobal('fetch', fetchImpl)
      const { default: server } = await import('../homebridge-ui/server.js')
      await expect(call(server)).rejects.toThrow(/invalid request/i)
      expect(fetchImpl).not.toHaveBeenCalled()
    })

    it('still defaults a missing clientId', async () => {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify(DEVICE_CODE), { status: 200 }))
      vi.stubGlobal('fetch', fetchImpl)
      const { default: server } = await import('../homebridge-ui/server.js')
      await server.requestDeviceCode(undefined)
      const body = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as URLSearchParams
      expect(body.get('client_id')).toBe('home_assistant')
    })
  })
})
