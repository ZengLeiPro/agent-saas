export interface TtsCapabilityConfig {
  enabled?: boolean;
  doubaoAppId?: string;
  doubaoApiKey?: string;
}

/** Production-safe TTS gate: opt-in plus complete credentials are both required. */
export function isTtsCapabilityEnabled(config: TtsCapabilityConfig | undefined): boolean {
  return config?.enabled === true
    && typeof config.doubaoAppId === 'string'
    && config.doubaoAppId.trim().length > 0
    && typeof config.doubaoApiKey === 'string'
    && config.doubaoApiKey.trim().length > 0;
}
