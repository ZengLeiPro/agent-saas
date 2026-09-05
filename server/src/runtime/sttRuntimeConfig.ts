import type { AppConfig, SttPricingConfig } from '../app/config.js';
import type { ResolvedAudioTranscribeConfig } from '../agent/audioTranscribeToolProvider.js';
import type { SttConfig } from '../integrations/stt/sttClient.js';
import { CredentialResolutionError } from '../security/credentialResolutionError.js';
import type { SecretVault } from '../security/secretVault.js';

const DEFAULT_BUCKET = 'ky-azeroth-upload';
const DEFAULT_ENDPOINT = 'https://oss-cn-shenzhen.aliyuncs.com';

/**
 * 旧配置没有 pricing；在管理员显式配置价格前保持零费用，避免迁移时凭空扣费。
 * AudioTranscribe 的计费模型始终是每次调用固定价格。
 */
export const DEFAULT_AUDIO_TRANSCRIBE_PRICING: Readonly<SttPricingConfig> = Object.freeze({
  creditsPerCall: 0,
  costYuanPerCall: 0,
});

type SttSourceConfig = AppConfig['stt'];

export interface ResolvedSttRuntimeConfig {
  /** Web 录音转写沿用的 STT 配置。 */
  sttConfig?: SttConfig;
  /** 直连 AudioTranscribe ToolProvider 使用；不依赖 audioTranscribeTenantIds。 */
  audioTranscribeConfig?: ResolvedAudioTranscribeConfig;
  /** 旧版隔离运行时注入通道，保留到调用方完成迁移。 */
  audioTranscribeEnvByTenant: ReadonlyMap<string, Readonly<Record<string, string>>>;
}

export async function resolveSttRuntimeConfig(
  source: SttSourceConfig,
  vault: SecretVault,
): Promise<ResolvedSttRuntimeConfig> {
  if (!source) {
    return { audioTranscribeEnvByTenant: new Map() };
  }

  const [apiKey, ossAccessKeyId, ossAccessKeySecret] = await Promise.all([
    resolveCredential(source.apiKey, source.apiKeyRef, 'apiKeyRef', vault),
    resolveCredential(source.ossAccessKeyId, source.ossAccessKeyIdRef, 'ossAccessKeyIdRef', vault),
    resolveCredential(source.ossAccessKeySecret, source.ossAccessKeySecretRef, 'ossAccessKeySecretRef', vault),
  ]);

  const configuredValues = [apiKey, ossAccessKeyId, ossAccessKeySecret].filter(Boolean).length;
  const tenantIds = [...new Set(source.audioTranscribeTenantIds ?? [])];
  if (configuredValues === 0) {
    if (source.enabled) {
      throw new Error('stt.enabled=true，但 STT/OSS 凭据为空');
    }
    if (tenantIds.length > 0) {
      throw new Error('stt.audioTranscribeTenantIds 已配置，但 STT/OSS 凭据为空');
    }
    return { audioTranscribeEnvByTenant: new Map() };
  }
  if (configuredValues < 3) {
    if (source.enabled || tenantIds.length > 0) {
      throw new Error('STT 配置不完整：apiKey、ossAccessKeyId、ossAccessKeySecret 必须同时配置 inline 值或 SecretVault ref');
    }
    // 管理端允许在工具关闭且没有旧租户注入时逐项清除；此时 Web/工具均不可用。
    return { audioTranscribeEnvByTenant: new Map() };
  }

  const sttConfig: SttConfig = {
    apiKey: apiKey!,
    ossAccessKeyId: ossAccessKeyId!,
    ossAccessKeySecret: ossAccessKeySecret!,
    ...(source.model ? { model: source.model } : {}),
    ossBucket: source.ossBucket || DEFAULT_BUCKET,
    ossEndpoint: source.ossEndpoint || DEFAULT_ENDPOINT,
  };
  const audioEnv = Object.freeze({
    DASHSCOPE_API_KEY: sttConfig.apiKey,
    OSS_ACCESS_KEY_ID: sttConfig.ossAccessKeyId,
    OSS_ACCESS_KEY_SECRET: sttConfig.ossAccessKeySecret,
    OSS_BUCKET: sttConfig.ossBucket!,
    OSS_ENDPOINT: sttConfig.ossEndpoint!,
  });
  const pricing: SttPricingConfig = source.pricing
    ? { ...source.pricing }
    : { ...DEFAULT_AUDIO_TRANSCRIBE_PRICING };

  return {
    sttConfig,
    audioTranscribeConfig: {
      enabled: source.enabled === true,
      sttConfig,
      pricing,
    },
    audioTranscribeEnvByTenant: new Map(
      tenantIds.map((tenantId) => [tenantId, audioEnv]),
    ),
  };
}

async function resolveCredential(
  inlineValue: string | undefined,
  ref: string | undefined,
  field: 'apiKeyRef' | 'ossAccessKeyIdRef' | 'ossAccessKeySecretRef',
  vault: SecretVault,
): Promise<string | undefined> {
  if (ref) {
    try {
      return await vault.getSecret(ref, {
        actor: 'system',
        userId: '__system__',
        scopes: ['secret:stt:read'],
      });
    } catch {
      throw new CredentialResolutionError(`stt.${field}`);
    }
  }
  return inlineValue?.trim() ? inlineValue : undefined;
}
