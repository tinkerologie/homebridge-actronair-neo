import { z } from 'zod'

/**
 * Plugin config as it appears in config.json. Every field is optional except the
 * Homebridge-supplied ones; defaults live here rather than scattered across the platform.
 *
 * The option set is deliberately at parity with the reference Home Assistant integration
 * (ha-actronair-neo): knobs it doesn't expose aren't exposed here either. `looseObject` means
 * a config still carrying a removed key (pushEnabled, commandDebounceMs, setpointDebounceMs,
 * zonesPushMaster, min/max{Heating,Cooling}Temp) is ignored silently rather than failing to
 * start — see test/config.test.ts.
 */
/**
 * Lowest poll interval honoured. The Neo cloud rate-limits at ~20 requests/minute, and a poll is
 * one request before any command traffic, so anything faster only buys 429s. A lower value is
 * clamped up (with a warning) rather than rejected: refusing to start over a too-eager interval
 * would be a worse outcome for the user than a slightly slower refresh.
 */
export const MIN_REFRESH_INTERVAL_S = 10

const ConfigSchema = z.looseObject({
  name: z.string().default('ActronAir Neo'),

  /** OAuth2 refresh token written by the custom settings UI. Absent until linked. */
  refreshToken: z.string().optional(),

  /** Only needed on accounts with more than one system. */
  deviceSerial: z.string().optional(),

  /** OAuth2 client id. Overridable in case ActronAir issues a plugin-specific one. */
  clientId: z.string().default('home_assistant'),

  refreshInterval: z.number().int().positive().default(60),

  zonesAsHeaterCoolers: z.boolean().default(false),

  debug: z.boolean().default(false),
})

export interface NeoConfig extends z.infer<typeof ConfigSchema> {
  refreshIntervalMs: number
  /** Non-fatal adjustments made while parsing; the platform logs each at startup. */
  warnings: string[]
}

export function parseConfig(raw: unknown): NeoConfig {
  const parsed = ConfigSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ')
    throw new Error(`Invalid plugin configuration — ${issues}`)
  }
  const warnings: string[] = []
  let refreshInterval = parsed.data.refreshInterval
  if (refreshInterval < MIN_REFRESH_INTERVAL_S) {
    warnings.push(`refreshInterval of ${refreshInterval}s is below the ${MIN_REFRESH_INTERVAL_S}s minimum (the ActronAir cloud rate-limits faster polling); using ${MIN_REFRESH_INTERVAL_S}s.`)
    refreshInterval = MIN_REFRESH_INTERVAL_S
  }
  return {
    ...parsed.data,
    refreshInterval,
    refreshIntervalMs: refreshInterval * 1000,
    warnings,
  }
}
