/**
 * WP2a 发布门禁：manifest 语义 diff（规范 §8.1）。
 *
 * 规范列出的「必须由非发布者复核」的语义变化：
 * `riskLevel` 降低、`required` 删除、`enum` 扩张、上界增大（`maximum` 升 / `minimum` 降）、
 * `additionalProperties` 放宽；再加上「新增或改名能力默认人工风险审核」与「人工审阅 description」。
 * 命中任意一条 → `reviewRequired = true` + 原因清单，`publish` 前必须先 `review`。
 *
 * 首个版本（无已发布基线）同样进人工复核：第一次把能力暴露给模型本身就是最高风险的一次。
 * 模型端工具注册 dry-run 由 `toolRegistrationDryRun` 钩子承载（WP3 填充）；
 * 未配置时结果记为 `skipped`，**不算通过**，并原样写进 publish 响应的 `gate` 字段。
 */
import type { Manifest, ManifestCapability } from '@kaiyan/ky-app-contract';

/** 语义 diff 的判定结果。 */
export interface KyAppPublishGateDiff {
  reviewRequired: boolean;
  /** 人类可读的原因清单，落库到版本行的 `reviewReasons`，供复核界面展示。 */
  reasons: string[];
}

/** 模型端工具注册 dry-run 的结论（规范 §8.1 最后一条）。 */
export type KyAppDryRunOutcome =
  | { status: 'passed' }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string };

export type KyAppToolRegistrationDryRun = (manifest: Manifest) => Promise<void>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function enumValues(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => JSON.stringify(item)) : [];
}

/** `read_only` 比 `external_write` 风险低：从 write 降到 read_only 会绕过原有的审批要求。 */
function riskLowered(previous: ManifestCapability, next: ManifestCapability): boolean {
  return previous.riskLevel === 'external_write' && next.riskLevel === 'read_only';
}

/**
 * 递归比较同一路径上的 schema 节点。只看规范点名的五类放宽，
 * 收紧（新增 required、enum 收缩、上界变小）不触发复核。
 */
function diffSchemaNode(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
  path: string,
  reasons: string[],
): void {
  const previousRequired = new Set(stringList(previous.required));
  const nextRequired = new Set(stringList(next.required));
  for (const field of previousRequired) {
    if (!nextRequired.has(field)) reasons.push(`${path}: required 删除了字段 ${field}`);
  }

  const previousEnum = enumValues(previous.enum);
  if (previousEnum.length > 0) {
    const nextEnum = new Set(enumValues(next.enum));
    const added = enumValues(next.enum).filter((item) => !previousEnum.includes(item));
    if (nextEnum.size === 0) reasons.push(`${path}: enum 被整体移除，取值不再受限`);
    else if (added.length > 0) reasons.push(`${path}: enum 扩张，新增取值 ${added.join('、')}`);
  }

  if (
    typeof previous.minimum === 'number' &&
    typeof next.minimum === 'number' &&
    next.minimum < previous.minimum
  ) {
    reasons.push(`${path}: minimum 由 ${previous.minimum} 降到 ${next.minimum}`);
  }
  if (typeof previous.minimum === 'number' && next.minimum === undefined) {
    reasons.push(`${path}: minimum 被移除`);
  }
  if (
    typeof previous.maximum === 'number' &&
    typeof next.maximum === 'number' &&
    next.maximum > previous.maximum
  ) {
    reasons.push(`${path}: maximum 由 ${previous.maximum} 升到 ${next.maximum}`);
  }
  if (typeof previous.maximum === 'number' && next.maximum === undefined) {
    reasons.push(`${path}: maximum 被移除`);
  }
  if (previous.additionalProperties === false && next.additionalProperties !== false) {
    reasons.push(`${path}: additionalProperties 由 false 放宽`);
  }

  const previousProperties = asRecord(previous.properties);
  const nextProperties = asRecord(next.properties);
  if (previousProperties && nextProperties) {
    for (const [key, child] of Object.entries(previousProperties)) {
      const previousChild = asRecord(child);
      const nextChild = asRecord(nextProperties[key]);
      if (previousChild && nextChild) {
        diffSchemaNode(previousChild, nextChild, `${path}.${key}`, reasons);
      }
    }
  }
  const previousItems = asRecord(previous.items);
  const nextItems = asRecord(next.items);
  if (previousItems && nextItems) diffSchemaNode(previousItems, nextItems, `${path}[]`, reasons);
}

function diffCapability(
  previous: ManifestCapability,
  next: ManifestCapability,
  reasons: string[],
): void {
  const label = `能力 ${next.id}`;
  if (riskLowered(previous, next)) {
    reasons.push(`${label}: riskLevel 由 external_write 降为 read_only`);
  }
  if (previous.approval === 'required' && next.approval !== 'required') {
    reasons.push(`${label}: approval 由 required 放宽为 ${next.approval}`);
  }
  if (previous.description !== next.description) {
    reasons.push(`${label}: description 变更，需人工审阅措辞`);
  }
  if (previous.name !== next.name)
    reasons.push(`${label}: 展示名由「${previous.name}」改为「${next.name}」`);
  diffSchemaNode(previous.inputSchema, next.inputSchema, `${label}.inputSchema`, reasons);
  diffSchemaNode(previous.outputSchema, next.outputSchema, `${label}.outputSchema`, reasons);
}

/**
 * 计算发布门禁的语义 diff。`previous` 为 null（首个版本）时一律要求复核。
 */
export function evaluateKyAppPublishGate(input: {
  previous: Manifest | null;
  next: Manifest;
}): KyAppPublishGateDiff {
  const reasons: string[] = [];
  if (!input.previous) {
    reasons.push('首个版本：能力清单与 description 首次进入模型可见范围，需人工风险审核');
    return { reviewRequired: true, reasons };
  }

  const previousById = new Map(input.previous.capabilities.map((item) => [item.id, item]));
  const nextById = new Map(input.next.capabilities.map((item) => [item.id, item]));
  for (const capability of input.next.capabilities) {
    const previous = previousById.get(capability.id);
    if (!previous) {
      reasons.push(`能力 ${capability.id}: 新增能力，默认人工风险审核`);
      continue;
    }
    diffCapability(previous, capability, reasons);
  }
  // 「改名」在契约里等价于「删旧 id + 加新 id」（§8.3：破坏性变更换 capabilityId），两侧都要提示。
  for (const capability of input.previous.capabilities) {
    if (!nextById.has(capability.id)) {
      reasons.push(`能力 ${capability.id}: 已从 manifest 移除或改名，需人工确认工具下线影响`);
    }
  }
  if ((input.previous.description ?? '') !== (input.next.description ?? '')) {
    reasons.push('系统 description 变更，需人工审阅措辞');
  }
  const previousPrefixes = [
    ...input.previous.pathPrefixes.user,
    ...input.previous.pathPrefixes.admin,
  ];
  const nextPrefixes = new Set([...input.next.pathPrefixes.user, ...input.next.pathPrefixes.admin]);
  for (const prefix of nextPrefixes) {
    if (!previousPrefixes.includes(prefix)) reasons.push(`pathPrefixes 新增 ${prefix}`);
  }
  return { reviewRequired: reasons.length > 0, reasons };
}

/** 跑模型端工具注册 dry-run；未配置钩子记 `skipped`（不等于通过）。 */
export async function runKyAppToolRegistrationDryRun(
  manifest: Manifest,
  dryRun: KyAppToolRegistrationDryRun | undefined,
): Promise<KyAppDryRunOutcome> {
  if (!dryRun) {
    return { status: 'skipped', reason: '未配置模型端工具注册 dry-run 钩子（WP3 填充）' };
  }
  try {
    await dryRun(manifest);
    return { status: 'passed' };
  } catch (error) {
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
}
