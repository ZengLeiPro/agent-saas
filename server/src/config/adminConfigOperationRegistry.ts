export type AdminConfigOperationId =
  | 'models.save'
  | 'tool-controls.save'
  | 'tool-controls.tool'
  | 'system-prompts.set'
  | 'system-prompts.reset'
  | 'memory-polling.save'
  | 'image-gen.config'
  | 'image-gen.pricing'
  | 'stt.save'
  | 'tenant-remote-hands.save'
  | 'codex.settings'
  | 'codex.order'
  | 'codex.complete'
  | 'codex.remove'
  | 'codex.disconnect'
  | 'grok.settings'
  | 'grok.order'
  | 'grok.complete'
  | 'grok.remove'
  | 'grok.disconnect';

export interface AdminConfigOperation {
  id: AdminConfigOperationId;
  /** 仅由具体路由绑定；生产发布器不接受客户端提供 target。 */
  target?: string;
}

type TokenPath = readonly string[];

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function scalarEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function changedConfigTokenPaths(
  before: unknown,
  after: unknown,
  prefix: readonly string[] = [],
): TokenPath[] {
  if (isRecord(before) || isRecord(after)) {
    const beforeRecord = isRecord(before) ? before : {};
    const afterRecord = isRecord(after) ? after : {};
    const keys = new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)]);
    const changes: TokenPath[] = [];
    for (const key of [...keys].sort()) {
      if (UNSAFE_KEYS.has(key)) throw new Error('配置包含禁止的对象键');
      changes.push(...changedConfigTokenPaths(beforeRecord[key], afterRecord[key], [...prefix, key]));
    }
    return changes;
  }
  return scalarEqual(before, after) ? [] : [prefix];
}

function startsWith(path: TokenPath, prefix: TokenPath): boolean {
  return prefix.length <= path.length && prefix.every((token, index) => path[index] === token);
}

function requireTarget(operation: AdminConfigOperation): string {
  const target = operation.target?.trim();
  if (!target || UNSAFE_KEYS.has(target)) throw new Error(`操作 ${operation.id} 缺少合法目标`);
  return target;
}

function allowedPrefixes(operation: AdminConfigOperation): TokenPath[] {
  switch (operation.id) {
    case 'models.save':
      return [
        ['models'],
        ['memory', 'index'],
        ['titleGenerator'],
        ['guardrail'],
        ['systemPrompts', 'utility.title'],
      ];
    case 'tool-controls.save':
      return [['toolControls'], ['webTools']];
    case 'tool-controls.tool':
      return [['toolControls', 'tools', requireTarget(operation)]];
    case 'system-prompts.set':
    case 'system-prompts.reset':
      return [['systemPrompts', requireTarget(operation)]];
    case 'memory-polling.save':
      return [['memory', 'polling']];
    case 'image-gen.config':
      return [['imageGenTools']];
    case 'image-gen.pricing':
      return [['imageGenTools', 'pricing']];
    case 'stt.save':
      return [['stt']];
    case 'tenant-remote-hands.save':
      return [['tenantRemoteHands']];
    case 'grok.settings':
      return [['grokSubscription', 'enabled'], ['grokSubscription', 'quotaCooldownMinutes'], ['grokSubscription', 'oauthClientId']];
    case 'grok.order':
      return [['grokSubscription', 'credentialRef'], ['grokSubscription', 'credentialRefs']];
    case 'grok.complete':
      return [['grokSubscription', 'enabled'], ['grokSubscription', 'quotaCooldownMinutes'], ['grokSubscription', 'credentialRef'], ['grokSubscription', 'credentialRefs']];
    case 'grok.remove':
    case 'grok.disconnect':
      return [['grokSubscription', 'enabled'], ['grokSubscription', 'credentialRef'], ['grokSubscription', 'credentialRefs']];
    case 'codex.settings':
      return [
        ['codexSubscription', 'enabled'],
        ['codexSubscription', 'websocketEnabled'],
        ['codexSubscription', 'quotaCooldownMinutes'],
      ];
    case 'codex.order':
      return [
        ['codexSubscription', 'credentialRef'],
        ['codexSubscription', 'credentialRefs'],
      ];
    case 'codex.complete':
    case 'codex.remove':
    case 'codex.disconnect':
      return [
        ['codexSubscription', 'enabled'],
        ['codexSubscription', 'websocketEnabled'],
        ['codexSubscription', 'credentialRef'],
        ['codexSubscription', 'credentialRefs'],
      ];
  }
}

export function assertAdminConfigOperationScope(
  operation: AdminConfigOperation | undefined,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): TokenPath[] {
  if (!operation) throw new Error('生产配置发布缺少服务端绑定的操作策略');
  const changed = changedConfigTokenPaths(before, after);
  const allowed = allowedPrefixes(operation);
  const outside = changed.filter((path) => !allowed.some((prefix) => startsWith(path, prefix)));
  if (operation.id === 'image-gen.config') {
    outside.push(...changed.filter((path) => startsWith(path, ['imageGenTools', 'pricing'])));
  }
  if (outside.length > 0) {
    throw new Error(`操作 ${operation.id} 试图修改未授权配置范围（其他配置段）`);
  }
  return changed;
}

export function adminConfigOperationAuditPath(operation: AdminConfigOperation): string {
  return operation.target ? `${operation.id}:${operation.target}` : operation.id;
}
