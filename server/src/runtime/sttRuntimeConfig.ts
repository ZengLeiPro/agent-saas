import type { AppConfig } from '../app/config.js';
import type { SttConfig } from '../integrations/stt/sttClient.js';
import type { SecretVault } from '../security/secretVault.js';

const DEFAULT_BUCKET = 'ky-azeroth-upload';
const DEFAULT_ENDPOINT = 'https://oss-cn-shenzhen.aliyuncs.com';

type SttSourceConfig = AppConfig['stt'];

export interface ResolvedSttRuntimeConfig {
  sttConfig?: SttConfig;
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
    if (tenantIds.length > 0) {
      throw new Error('stt.audioTranscribeTenantIds 已配置，但 STT/OSS 凭据为空');
    }
    return { audioTranscribeEnvByTenant: new Map() };
  }
  if (configuredValues < 3) {
    throw new Error('STT 配置不完整：apiKey、ossAccessKeyId、ossAccessKeySecret 必须同时配置 inline 值或 SecretVault ref');
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

  return {
    sttConfig,
    audioTranscribeEnvByTenant: new Map(
      tenantIds.map((tenantId) => [tenantId, audioEnv]),
    ),
  };
}

async function resolveCredential(
  inlineValue: string | undefined,
  ref: string | undefined,
  field: string,
  vault: SecretVault,
): Promise<string | undefined> {
  if (ref) {
    try {
      return await vault.getSecret(ref, {
        actor: 'system',
        userId: '__system__',
        scopes: ['secret:stt:read'],
      });
    } catch (error) {
      throw new Error(
        `stt.${field} "${ref}" 解析失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return inlineValue?.trim() ? inlineValue : undefined;
}
