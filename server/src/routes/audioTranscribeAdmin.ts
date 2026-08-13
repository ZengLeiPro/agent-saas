import { readFileSync, writeFileSync } from 'node:fs';
import { Router } from 'express';
import { applyEdits, modify, parse as parseJsonc } from 'jsonc-parser';

import { isToolEnabled } from '../agent/toolRuntime.js';
import { getAppConfigPath, parseAppConfig } from '../app/config.js';
import type { AppConfig, SttConfig } from '../app/config.js';
import { requirePlatformAdmin } from '../auth/middleware.js';
import { GLOBAL_OWNER_ID, type SecretVault } from '../security/secretVault.js';

const DEFAULT_BUCKET = 'ky-azeroth-upload';
const DEFAULT_ENDPOINT = 'https://oss-cn-shenzhen.aliyuncs.com';
const WRITER_PRINCIPAL = 'audio_transcribe_config_admin';

export interface CreateAudioTranscribeAdminRouterOptions {
  processCwd: string;
  config: AppConfig;
  secretVault?: SecretVault;
  /** 在落盘前验证新的 STT 配置能否被当前运行时接受。 */
  validate?: (stt: AppConfig['stt']) => Promise<void> | void;
  /** 配置落盘并更新进程内对象后触发热更新。 */
  onUpdated?: (stt: AppConfig['stt']) => Promise<void> | void;
}

type RawObject = Record<string, unknown>;
type SecretAppKey = 'apiKey' | 'ossAccessKeyId' | 'ossAccessKeySecret';
type SecretRefKey = 'apiKeyRef' | 'ossAccessKeyIdRef' | 'ossAccessKeySecretRef';

interface SecretFieldDefinition {
  envKey: 'DASHSCOPE_API_KEY' | 'OSS_ACCESS_KEY_ID' | 'OSS_ACCESS_KEY_SECRET';
  appKey: SecretAppKey;
  refKey: SecretRefKey;
}

const SECRET_FIELDS: readonly SecretFieldDefinition[] = [
  { envKey: 'DASHSCOPE_API_KEY', appKey: 'apiKey', refKey: 'apiKeyRef' },
  { envKey: 'OSS_ACCESS_KEY_ID', appKey: 'ossAccessKeyId', refKey: 'ossAccessKeyIdRef' },
  { envKey: 'OSS_ACCESS_KEY_SECRET', appKey: 'ossAccessKeySecret', refKey: 'ossAccessKeySecretRef' },
];

function isRecord(value: unknown): value is RawObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value: RawObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function firstPresent(source: RawObject, keys: readonly string[]): { present: boolean; value?: unknown } {
  for (const key of keys) {
    if (hasOwn(source, key)) return { present: true, value: source[key] };
  }
  return { present: false };
}

function credentialConfigured(stt: SttConfig | undefined, field: SecretFieldDefinition): boolean {
  return Boolean(stt?.[field.appKey]?.trim() || stt?.[field.refKey]?.trim());
}

/** 管理 API 永远不序列化 inline secret 或 SecretVault ref。 */
function adminView(config: AppConfig) {
  const stt = config.stt;
  const missingCredentials = SECRET_FIELDS
    .filter((field) => !credentialConfigured(stt, field))
    .map((field) => field.envKey);
  const platformEnabled = stt?.enabled === true;
  const toolEnabled = isToolEnabled(config.toolControls, 'AudioTranscribe');
  const credentialsConfigured = missingCredentials.length === 0;

  return {
    config: {
      enabled: platformEnabled,
      model: stt?.model,
      ossBucket: stt?.ossBucket || DEFAULT_BUCKET,
      ossEndpoint: stt?.ossEndpoint || DEFAULT_ENDPOINT,
      apiKeyConfigured: credentialConfigured(stt, SECRET_FIELDS[0]!),
      ossAccessKeyIdConfigured: credentialConfigured(stt, SECRET_FIELDS[1]!),
      ossAccessKeySecretConfigured: credentialConfigured(stt, SECRET_FIELDS[2]!),
    },
    pricing: stt?.pricing ?? null,
    status: {
      available: platformEnabled && toolEnabled && credentialsConfigured,
      platformEnabled,
      toolEnabled,
      credentialsConfigured,
    },
  };
}

function requestedConfig(body: unknown): { config: RawObject; pricingPresent: boolean; pricing?: unknown } {
  if (!isRecord(body)) throw new Error('请求体必须是对象');
  const config = isRecord(body.config) ? body.config : body;
  const pricingSource = firstPresent(body, ['pricing']);
  if (pricingSource.present) return { config, pricingPresent: true, pricing: pricingSource.value };
  const nestedPricing = firstPresent(config, ['pricing']);
  return {
    config,
    pricingPresent: nestedPricing.present,
    pricing: nestedPricing.value,
  };
}

function mergeRequestedStt(currentRaw: unknown, body: unknown): { rawRecord: RawObject; staged: RawObject } {
  const rawRecord = isRecord(currentRaw) ? currentRaw : {};
  const current = isRecord(rawRecord.stt) ? rawRecord.stt : {};
  const requested = requestedConfig(body);
  const staged: RawObject = { ...current };

  const enabled = firstPresent(requested.config, ['enabled']);
  if (enabled.present) staged.enabled = enabled.value;
  const model = firstPresent(requested.config, ['model']);
  if (model.present) staged.model = model.value;

  const bucket = firstPresent(requested.config, ['OSS_BUCKET', 'ossBucket']);
  if (bucket.present) staged.ossBucket = bucket.value;
  const endpoint = firstPresent(requested.config, ['OSS_ENDPOINT', 'ossEndpoint']);
  if (endpoint.present) staged.ossEndpoint = endpoint.value;

  if (requested.pricingPresent) {
    if (requested.pricing === null) delete staged.pricing;
    else staged.pricing = requested.pricing;
  }

  for (const field of SECRET_FIELDS) {
    const input = firstPresent(requested.config, [field.envKey, field.appKey]);
    if (!input.present) continue;

    // GET 响应可直接 round-trip；{ configured } 与空字符串都表示保留旧值。
    if (isRecord(input.value) && typeof input.value.configured === 'boolean') continue;
    if (input.value === '') continue;
    if (input.value === null) {
      delete staged[field.appKey];
      delete staged[field.refKey];
      continue;
    }
    if (typeof input.value !== 'string') {
      throw new Error(`config.${field.envKey} 必须是字符串、null 或 configured 状态对象`);
    }
    if (!input.value.trim()) continue;
    delete staged[field.refKey];
    staged[field.appKey] = input.value;
  }

  return { rawRecord, staged };
}

function safeErrorMessage(error: unknown, stt: SttConfig | undefined, body: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  const values = new Set<string>();
  const submitted = isRecord(body) ? requestedConfig(body).config : {};
  for (const field of SECRET_FIELDS) {
    for (const value of [stt?.[field.appKey], stt?.[field.refKey]]) {
      if (typeof value === 'string' && value) values.add(value);
    }
    const input = firstPresent(submitted, [field.envKey, field.appKey]);
    if (typeof input.value === 'string' && input.value) values.add(input.value);
  }
  for (const value of values) message = message.replaceAll(value, '[REDACTED]');
  return message;
}

function assertEnabledCredentialsComplete(staged: SttConfig | undefined): void {
  if (staged?.enabled !== true) return;
  const missing = SECRET_FIELDS
    .filter((field) => !credentialConfigured(staged, field))
    .map((field) => field.envKey);
  if (missing.length > 0) {
    throw new Error(`启用 AudioTranscribe 前必须完整配置：${missing.join('、')}`);
  }
}

async function persistSubmittedSecrets(
  staged: SttConfig | undefined,
  body: unknown,
  vault?: SecretVault,
): Promise<SttConfig | undefined> {
  if (!staged) return staged;
  const requested = requestedConfig(body).config;
  const next: RawObject = { ...staged };

  for (const field of SECRET_FIELDS) {
    const input = firstPresent(requested, [field.envKey, field.appKey]);
    const submittedValue = typeof input.value === 'string' && input.value.trim()
      ? input.value
      : undefined;
    // 空字符串保留现有 ref；旧 inline 值则在本次管理端保存时顺手迁入 Vault。
    const value = submittedValue ?? next[field.appKey];
    if (typeof value !== 'string' || !value.trim()) continue;
    if (!vault) throw new Error('SecretVault 未配置，不能保存 AudioTranscribe 密钥');
    const ref = await vault.putSecret(
      GLOBAL_OWNER_ID,
      'stt',
      value,
      {
        actor: 'system',
        userId: WRITER_PRINCIPAL,
        scopes: ['secret:stt:write'],
      },
      { env: field.envKey, purpose: 'audio-transcribe' },
    );
    delete next[field.appKey];
    next[field.refKey] = ref.id;
  }

  return next as SttConfig;
}

export function createAudioTranscribeAdminRouter(
  options: CreateAudioTranscribeAdminRouterOptions,
): Router {
  const router = Router();
  router.use(requirePlatformAdmin);

  router.get('/', (_req, res) => {
    res.json(adminView(options.config));
  });

  router.put('/', async (req, res) => {
    const configPath = getAppConfigPath(options.processCwd);
    let configText: string;
    let rawRecord: RawObject;
    let staged: SttConfig | undefined;

    try {
      configText = readFileSync(configPath, 'utf-8');
      const merged = mergeRequestedStt(parseJsonc(configText), req.body);
      rawRecord = merged.rawRecord;
      // 先整份校验，确保非法价格等错误不会产生 SecretVault 或磁盘副作用。
      staged = parseAppConfig({ ...rawRecord, stt: merged.staged }).stt;
      assertEnabledCredentialsComplete(staged);
      staged = await persistSubmittedSecrets(staged, req.body, options.secretVault);
      // ref 替换 inline 后再次按整份 AppConfig 校验，并执行运行时预检。
      staged = parseAppConfig({ ...rawRecord, stt: staged }).stt;
      await options.validate?.(staged);
    } catch (error) {
      res.status(400).json({ error: safeErrorMessage(error, staged, req.body) });
      return;
    }

    try {
      const edits = modify(configText, ['stt'], staged, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      });
      writeFileSync(configPath, applyEdits(configText, edits), 'utf-8');
      options.config.stt = staged;
      await options.onUpdated?.(staged);
      res.json(adminView(options.config));
    } catch (error) {
      res.status(500).json({ error: safeErrorMessage(error, staged, req.body) });
    }
  });

  return router;
}
