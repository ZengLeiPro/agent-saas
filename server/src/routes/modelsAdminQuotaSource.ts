import type { ModelGroup, ModelsConfig } from '../app/config.js';
import { GLOBAL_OWNER_ID, type SecretVault } from '../security/secretVault.js';

/**
 * 模型分组 `quotaSource` 的凭据处理，与分组 apiKey 同一套语义：
 * GET 不回显 Secret（只给 hasQuotaSecret）；PUT 留空/缺失 = 保留现有；
 * 新提交的明文进 SecretVault、config 只落 `secretAccessKeyRef`。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function redactGroupQuotaSource(group: ModelGroup): Record<string, unknown> {
  const { quotaSource, ...rest } = group;
  if (!quotaSource) return rest;
  const { secretAccessKey, secretAccessKeyRef, ...safe } = quotaSource;
  return {
    ...rest,
    quotaSource: { ...safe, hasQuotaSecret: Boolean(secretAccessKey || secretAccessKeyRef) },
  };
}

/** PUT 请求体里的分组：Secret 留空时按现有配置补回 ref / inline。 */
export function restoreGroupQuotaSourceSecret(
  groupRaw: Record<string, unknown>,
  current: ModelGroup | undefined,
): Record<string, unknown> {
  if (!isRecord(groupRaw.quotaSource)) return groupRaw;
  const {
    hasQuotaSecret: _ignored,
    secretAccessKeyRef: _clientRef,
    ...source
  } = groupRaw.quotaSource;
  const inline = typeof source.secretAccessKey === 'string' ? source.secretAccessKey : undefined;
  if (inline && inline.length > 0) return { ...groupRaw, quotaSource: source };
  const { secretAccessKey: _empty, ...withoutSecret } = source;
  const persisted = current?.quotaSource;
  if (persisted?.secretAccessKeyRef) {
    return {
      ...groupRaw,
      quotaSource: { ...withoutSecret, secretAccessKeyRef: persisted.secretAccessKeyRef },
    };
  }
  if (persisted?.secretAccessKey) {
    return {
      ...groupRaw,
      quotaSource: { ...withoutSecret, secretAccessKey: persisted.secretAccessKey },
    };
  }
  return { ...groupRaw, quotaSource: withoutSecret };
}

/** 请求体里带了新 Secret 明文（且与现有 inline 不同）的分组 id。 */
export function submittedQuotaSecretGroups(
  body: unknown,
  current: ModelsConfig | undefined,
): Set<string> {
  if (!isRecord(body) || !isRecord(body.models) || !Array.isArray(body.models.groups))
    return new Set();
  return new Set(
    body.models.groups.flatMap((value) => {
      if (!isRecord(value) || typeof value.id !== 'string' || !isRecord(value.quotaSource))
        return [];
      const secret = value.quotaSource.secretAccessKey;
      if (typeof secret !== 'string' || !secret.trim()) return [];
      const existing = current?.groups.find((group) => group.id === value.id)?.quotaSource;
      return existing?.secretAccessKey === secret ? [] : [value.id];
    }),
  );
}

/** 解析后的分组若声明了 quotaSource，必须已经拿到 Secret（明文或 ref）。 */
export function assertQuotaSourcesComplete(models: ModelsConfig): void {
  for (const group of models.groups) {
    const source = group.quotaSource;
    if (source && !source.secretAccessKey && !source.secretAccessKeyRef) {
      throw new Error(`models.${group.id}.quotaSource 配置缺少 Secret Access Key`);
    }
  }
}

/** 与 modelsAdmin 的 CreatedSecretRef 同形，便于共用同一批 created/replaced 列表。 */
export type QuotaSecretRef = { ref: string; kind: 'models' | 'memory_index' };

export async function persistSubmittedQuotaSecrets(input: {
  models: ModelsConfig;
  submittedGroups: Set<string>;
  secretVault?: SecretVault;
  createdRefs: QuotaSecretRef[];
  replacedRefs: QuotaSecretRef[];
  /** 现有配置里每个分组的 quotaSource.secretAccessKeyRef。 */
  previousRefs: Map<string, string | undefined>;
}): Promise<ModelsConfig> {
  const groups = await Promise.all(
    input.models.groups.map(async (group) => {
      const source = group.quotaSource;
      if (!source || !input.submittedGroups.has(group.id) || !source.secretAccessKey) return group;
      if (!input.secretVault) throw new Error('SecretVault 未配置，不能保存套餐用量查询 Secret');
      const ref = await input.secretVault.putSecret(
        GLOBAL_OWNER_ID,
        'models',
        source.secretAccessKey,
        { actor: 'system', userId: 'models_config_admin', scopes: ['secret:models:write'] },
        { groupId: group.id, purpose: 'quota-source', provider: source.provider },
      );
      input.createdRefs.push({ ref: ref.id, kind: 'models' });
      const { secretAccessKey: _plain, ...safe } = source;
      return { ...group, quotaSource: { ...safe, secretAccessKeyRef: ref.id } };
    }),
  );
  // 被替换或整个 quotaSource 被移除的旧 ref 一并回收。
  for (const [groupId, previousRef] of input.previousRefs) {
    if (!previousRef) continue;
    const nextRef = groups.find((group) => group.id === groupId)?.quotaSource?.secretAccessKeyRef;
    if (nextRef !== previousRef) input.replacedRefs.push({ ref: previousRef, kind: 'models' });
  }
  return { ...input.models, groups };
}
