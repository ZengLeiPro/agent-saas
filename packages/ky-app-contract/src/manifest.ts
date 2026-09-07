/**
 * 附录 A：manifest 结构校验 + 「附加校验」全部语义规则（§4.5）。
 *
 * 返回 `warnings` 与 `errors` 分开：`description` 的指令性触发词只是告警，不算失败。
 */
import { validateManifestSchema } from './schemas/index.js';
import { PathError, normalizeAppPath, normalizeToolSegment, toolName } from './path.js';
import {
  CAPABILITY_SCHEMA_FORBIDDEN_KEYWORDS,
  CAPABILITY_SCHEMA_KEYWORDS,
  CAPABILITY_SCHEMA_TYPES,
  type Manifest,
  type ManifestCapability,
} from './types/manifest.js';
import {
  CAPABILITY_SCHEMA_MAX_BYTES,
  CAPABILITY_SCHEMA_MAX_DEPTH,
  RESERVED_PATH_PREFIXES,
} from './types/constants.js';

export interface ManifestValidationResult {
  ok: boolean;
  errors: string[];
  /** 告警不算失败：目前只有 description 指令性触发词。 */
  warnings: string[];
}

const ALLOWED_KEYWORDS: ReadonlySet<string> = new Set<string>(CAPABILITY_SCHEMA_KEYWORDS);
const FORBIDDEN_KEYWORDS: ReadonlySet<string> = new Set<string>(
  CAPABILITY_SCHEMA_FORBIDDEN_KEYWORDS,
);
const ALLOWED_TYPES: ReadonlySet<string> = new Set<string>(CAPABILITY_SCHEMA_TYPES);

/**
 * `description` 里的指令性触发词。命中只告警：写成「做什么/返回什么/何时用」，
 * 不要写成对模型的命令，避免 manifest 变成提示注入面。
 */
export const INSTRUCTION_TRIGGER_WORDS = [
  '忽略以上',
  '忽略之前',
  '忽略前面',
  '无视',
  '必须调用',
  '总是调用',
  '优先调用',
  '立即执行',
  '自动执行',
  '无需确认',
  '不要询问',
  '不用确认',
  '绕过',
  '系统提示',
  'ignore previous',
  'ignore all',
  'disregard',
  'you must',
  'always call',
  'system prompt',
  'do not ask',
  'without confirmation',
] as const;

/** 附录 A 结构校验 + §4.5 附加校验。 */
export function validateManifest(manifest: unknown): ManifestValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const schemaResult = validateManifestSchema(manifest);
  if (!schemaResult.ok) {
    return { ok: false, errors: schemaResult.errors.map((item) => `schema: ${item}`), warnings };
  }

  const value = manifest as Manifest;
  checkPathPrefixes(value, errors);
  checkCapabilities(value, errors, warnings);

  return { ok: errors.length === 0, errors, warnings };
}

function checkPathPrefixes(manifest: Manifest, errors: string[]): void {
  const all = [...manifest.pathPrefixes.user, ...manifest.pathPrefixes.admin];
  for (const prefix of all) {
    if (!prefix.startsWith('/') || !prefix.endsWith('/') || prefix === '/') {
      errors.push(`pathPrefixes: ${prefix} 必须以 / 开头结尾且不得为 /`);
      continue;
    }
    for (const reserved of RESERVED_PATH_PREFIXES) {
      if (prefix === reserved || prefix.startsWith(reserved)) {
        errors.push(`pathPrefixes: ${prefix} 覆盖了保留前缀 ${reserved}`);
      }
    }
  }
  const seen = new Set<string>();
  for (const prefix of all) {
    if (seen.has(prefix)) errors.push(`pathPrefixes: ${prefix} 重复`);
    seen.add(prefix);
  }
}

function checkCapabilities(manifest: Manifest, errors: string[], warnings: string[]): void {
  const rawIds = new Set<string>();
  const normalizedIds = new Map<string, string>();
  const toolNames = new Map<string, string>();

  for (const capability of manifest.capabilities) {
    const label = `capabilities[${capability.id}]`;

    if (rawIds.has(capability.id)) errors.push(`${label}: id 重复`);
    rawIds.add(capability.id);

    const normalized = normalizeToolSegment(capability.id);
    const owner = normalizedIds.get(normalized);
    if (owner !== undefined) {
      errors.push(`${label}: 规范化后的 id ${normalized} 与 ${owner} 碰撞`);
    } else {
      normalizedIds.set(normalized, capability.id);
    }

    try {
      const name = toolName(manifest.systemId, capability.id);
      const nameOwner = toolNames.get(name);
      if (nameOwner !== undefined) {
        errors.push(`${label}: 工具名 ${name} 与 ${nameOwner} 碰撞`);
      } else {
        toolNames.set(name, capability.id);
      }
    } catch (error) {
      errors.push(`${label}: ${(error as PathError).message}`);
    }

    checkCapabilitySchema(capability.inputSchema, `${label}.inputSchema`, errors);
    checkCapabilitySchema(capability.outputSchema, `${label}.outputSchema`, errors);
    checkResultLink(capability, label, errors);
    checkDescription(capability, label, warnings);
  }
}

function checkDescription(capability: ManifestCapability, label: string, warnings: string[]): void {
  const lowered = capability.description.toLowerCase();
  for (const word of INSTRUCTION_TRIGGER_WORDS) {
    if (lowered.includes(word.toLowerCase())) {
      warnings.push(
        `${label}.description 含指令性触发词「${word}」，请改写为「做什么/返回什么/何时用」`,
      );
    }
  }
}

/** §4.5 模型可见的能力 schema 子集校验。 */
export function checkCapabilitySchema(schema: unknown, label: string, errors: string[]): void {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    errors.push(`${label}: 必须是 JSON 对象`);
    return;
  }
  const bytes = new TextEncoder().encode(JSON.stringify(schema)).byteLength;
  if (bytes > CAPABILITY_SCHEMA_MAX_BYTES) {
    errors.push(`${label}: ${bytes} 字节超过 ${CAPABILITY_SCHEMA_MAX_BYTES}`);
  }
  const root = schema as Record<string, unknown>;
  if (root.type !== 'object') errors.push(`${label}: 顶层 type 必须是 object`);
  if (root.additionalProperties !== false) {
    errors.push(`${label}: 顶层必须显式 additionalProperties:false`);
  }
  walkCapabilitySchema(root, 1, label, errors);
}

function walkCapabilitySchema(
  node: Record<string, unknown>,
  depth: number,
  label: string,
  errors: string[],
): void {
  if (depth > CAPABILITY_SCHEMA_MAX_DEPTH) {
    errors.push(`${label}: 嵌套深度 ${depth} 超过 ${CAPABILITY_SCHEMA_MAX_DEPTH}`);
    return;
  }
  for (const keyword of Object.keys(node)) {
    if (FORBIDDEN_KEYWORDS.has(keyword)) {
      errors.push(`${label}: 禁止使用关键字 ${keyword}`);
      continue;
    }
    if (!ALLOWED_KEYWORDS.has(keyword)) {
      errors.push(`${label}: 关键字 ${keyword} 不在能力 schema 子集白名单内`);
    }
  }
  const type = node.type;
  if (type !== undefined && (typeof type !== 'string' || !ALLOWED_TYPES.has(type))) {
    errors.push(`${label}: type ${JSON.stringify(type)} 不在允许集合内（不接受 type 数组）`);
  }
  const properties = node.properties;
  if (properties !== undefined) {
    if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
      errors.push(`${label}: properties 必须是对象`);
    } else {
      for (const [key, child] of Object.entries(properties as Record<string, unknown>)) {
        descend(child, depth + 1, `${label}.properties.${key}`, errors);
      }
    }
  }
  const items = node.items;
  if (items !== undefined) descend(items, depth + 1, `${label}.items`, errors);
}

function descend(child: unknown, depth: number, label: string, errors: string[]): void {
  if (typeof child !== 'object' || child === null || Array.isArray(child)) {
    errors.push(`${label}: 子 schema 必须是对象（不接受布尔 schema 与元组数组）`);
    return;
  }
  walkCapabilitySchema(child as Record<string, unknown>, depth, label, errors);
}

const PLACEHOLDER = /\{data\.([A-Za-z0-9_]+)\}/gu;

function checkResultLink(capability: ManifestCapability, label: string, errors: string[]): void {
  const link = capability.resultLink;
  if (link === undefined || link === null) return;

  const matches = [...link.path.matchAll(PLACEHOLDER)];
  const stripped = link.path.replace(PLACEHOLDER, 'x');
  if (stripped.includes('{') || stripped.includes('}')) {
    errors.push(`${label}.resultLink.path 含非 {data.<field>} 形式的占位`);
  }
  try {
    normalizeAppPath(stripped);
  } catch (error) {
    errors.push(`${label}.resultLink.path 不满足 §5.2：${(error as PathError).message}`);
  }

  const containers = resultLinkFieldContainers(capability.outputSchema);
  for (const match of matches) {
    const field = match[1] as string;
    const candidates = containers
      .map((container) => container[field])
      .filter((target): target is Record<string, unknown> => isSchemaObject(target));
    if (candidates.length === 0) {
      errors.push(`${label}.resultLink.path 占位 {data.${field}} 在 outputSchema 中不存在`);
      continue;
    }
    const types = candidates.map((candidate) => candidate.type);
    if (!types.every((type) => type === 'string' || type === 'integer')) {
      errors.push(
        `${label}.resultLink.path 占位 {data.${field}} 的类型是 ${JSON.stringify(types[0])}，必须是 string 或 integer`,
      );
    }
  }
}

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 占位可以指向 outputSchema 的顶层字段，也可以指向分页列表 `items[]` 的元素字段
 * ——附录 A 的示例里 `order.search` 的 `{data.orderId}` 就是后者（列表逐条渲染链接）。
 */
function resultLinkFieldContainers(outputSchema: unknown): Array<Record<string, unknown>> {
  if (!isSchemaObject(outputSchema)) return [];
  const topLevel = outputSchema.properties;
  if (!isSchemaObject(topLevel)) return [];
  const containers: Array<Record<string, unknown>> = [topLevel];
  for (const property of Object.values(topLevel)) {
    if (!isSchemaObject(property) || property.type !== 'array') continue;
    const items = property.items;
    if (!isSchemaObject(items)) continue;
    const itemProperties = items.properties;
    if (isSchemaObject(itemProperties)) containers.push(itemProperties);
  }
  return containers;
}
