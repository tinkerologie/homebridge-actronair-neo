import { HomebridgePluginUiServer } from '@homebridge/plugin-ui-utils'

const BASE = 'https://nimbus.actronair.com.au'
const DEFAULT_CLIENT_ID = 'home_assistant'
/**
 * Node's fetch has no default timeout — a half-open connection would otherwise hang the
 * settings UI forever.
 */
const TIMEOUT_MS = 10_000
/** RFC 8628 §3.2: when the server omits `interval`, clients must wait 5 seconds between polls. */
const MIN_POLL_INTERVAL_S = 5
/**
 * Printable ASCII only. These values end up in a form body or an `Authorization` header, and
 * come from the browser, so anything else (control characters, CR/LF) is a malformed request.
 */
const TOKEN_LIKE = /^[\x21-\x7E]+$/

/**
 * Every handler's input arrives from the browser as arbitrary JSON. Reject anything that is
 * not a non-empty printable string before it reaches the network, so a type confusion (an
 * object, an array, a number) can never be coerced into a request to the cloud.
 */
function requireString(value, name) {
  if (typeof value !== 'string' || !TOKEN_LIKE.test(value))
    throw new Error(`Invalid request: ${name} must be a non-empty string.`)
  return value
}

/** `clientId` is optional (it defaults), but when it is sent it must be valid. */
function clientIdOrDefault(clientId) {
  return clientId === undefined || clientId === null
    ? DEFAULT_CLIENT_ID
    : requireString(clientId, 'clientId')
}

/** The verification page the cloud has been seen to return lives on this domain. */
const VERIFICATION_DOMAIN = 'actronair.com.au'

/**
 * Only an https URL on the ActronAir domain may become the browser's clickable link. The user
 * types their account credentials into whatever page this opens, so a link elsewhere (a
 * tampered or misconfigured response) must never be offered.
 */
function httpsUrlOrUndefined(value) {
  if (typeof value !== 'string')
    return undefined
  try {
    const url = new URL(value)
    const onDomain = url.hostname === VERIFICATION_DOMAIN || url.hostname.endsWith(`.${VERIFICATION_DOMAIN}`)
    return url.protocol === 'https:' && onDomain
      ? value
      : undefined
  }
  catch {
    return undefined
  }
}

/**
 * The browser renders `verification_uri` as a link and drives its poll loop from `interval`
 * and `expires_in`, so the cloud's response is validated here rather than trusted: a
 * `javascript:` URI would be clickable, a missing `interval` would make `setTimeout(NaN)` poll
 * the token endpoint in a hot loop, and a missing `expires_in` would end linking at once with
 * a misleading "timed out".
 */
export function normaliseDeviceCode(json) {
  const verificationUri = httpsUrlOrUndefined(json?.verification_uri)
  const verificationUriComplete = httpsUrlOrUndefined(json?.verification_uri_complete)
  const valid = typeof json?.device_code === 'string' && json.device_code
    && typeof json.user_code === 'string' && json.user_code
    && verificationUri
    && Number.isFinite(json.expires_in) && json.expires_in > 0
  if (!valid)
    throw new Error('The ActronAir cloud returned an unexpected response while starting account linking. Please try again.')

  const interval = Number.isFinite(json.interval)
    ? Math.max(json.interval, MIN_POLL_INTERVAL_S)
    : MIN_POLL_INTERVAL_S
  return {
    ...json,
    verification_uri: verificationUri,
    verification_uri_complete: verificationUriComplete,
    expires_in: json.expires_in,
    interval,
  }
}

class UiServer extends HomebridgePluginUiServer {
  constructor() {
    super()
    this.onRequest('/device-code', ({ clientId } = {}) => this.requestDeviceCode(clientId))
    this.onRequest('/poll-token', p => this.pollToken(p))
    this.onRequest('/account', p => this.account(p))
    this.onRequest('/session', p => this.session(p))
    this.ready()
  }

  async form(body) {
    const res = await fetch(`${BASE}/api/v0/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    return { status: res.status, json: await res.json().catch(() => ({})) }
  }

  async requestDeviceCode(clientId) {
    const { status, json } = await this.form({
      client_id: clientIdOrDefault(clientId),
      scope: 'read write',
    })
    if (status !== 200)
      throw new Error(`Could not start account linking (HTTP ${status})`)
    return normaliseDeviceCode(json)
  }

  /** One poll attempt — the browser drives the loop so it can show progress. */
  async pollToken({ clientId, deviceCode } = {}) {
    const { status, json } = await this.form({
      client_id: clientIdOrDefault(clientId),
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: requireString(deviceCode, 'deviceCode'),
    })
    if (status === 200) {
      // The refresh token is the only thing linking saves; a 200 without one must not be
      // reported as "Account linked" with nothing written to the config.
      if (typeof json.refresh_token !== 'string' || !json.refresh_token)
        return { state: 'failed', error: 'The ActronAir cloud did not return a refresh token' }
      return { state: 'authorised', refreshToken: json.refresh_token, accessToken: json.access_token }
    }
    if (json.error === 'authorization_pending' || json.error === 'slow_down')
      return { state: 'pending', slowDown: json.error === 'slow_down' }
    return { state: 'failed', error: json.error ?? `HTTP ${status}` }
  }

  /**
   * Exchange the stored refresh token for a fresh access token, so a reopened
   * settings page can show who's linked without ever persisting the access token.
   * The API does not rotate the refresh token on this call — do not expect one back.
   */
  async session({ clientId, refreshToken } = {}) {
    const { status, json } = await this.form({
      client_id: clientIdOrDefault(clientId),
      grant_type: 'refresh_token',
      refresh_token: requireString(refreshToken, 'refreshToken'),
    })
    if (status === 400 || status === 401)
      return { state: 'invalid' }
    if (status !== 200)
      throw new Error(`Could not reach the ActronAir cloud (HTTP ${status}). Please try again.`)
    return { state: 'ok', accessToken: json.access_token }
  }

  /**
   * GET returning JSON, with the status actually checked. Without the `res.ok` guard a
   * 429/5xx (or an HTML error page) parses to something without `_embedded`, which the
   * caller's `?? []` then renders as a perfectly calm "linked, zero systems" — a transient
   * cloud failure made indistinguishable from an empty account, on the first screen the
   * user sees after linking.
   */
  async getJson(url, headers, signal) {
    const res = await fetch(url, { headers, signal })
    if (!res.ok)
      throw new Error(`Could not reach the ActronAir cloud (HTTP ${res.status}). Please try again.`)
    return res.json().catch(() => {
      throw new Error('The ActronAir cloud returned an unreadable response. Please try again.')
    })
  }

  /** Confirm which account was linked and list its systems, so the user can sanity-check. */
  async account({ accessToken } = {}) {
    const headers = { Authorization: `Bearer ${requireString(accessToken, 'accessToken')}`, Accept: 'application/json' }
    const signal = AbortSignal.timeout(TIMEOUT_MS)
    const [account, systems] = await Promise.all([
      this.getJson(`${BASE}/api/v0/client/account`, headers, signal),
      this.getJson(`${BASE}/api/v0/client/ac-systems?includeNeo=true`, headers, signal),
    ])
    return {
      email: account.email,
      systems: (systems?._embedded?.['ac-system'] ?? []).map(s => ({ serial: s.serial, name: s.description })),
    }
  }
}

export default new UiServer()
