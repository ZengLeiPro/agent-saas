/**
 * WP3：模型端工具注册 dry-run（规范 §8.1 最后一条；WP2a 在 `publishGate.ts:28` 预留的钩子）。
 *
 * 发布门禁调用它，用**真实的 provider 构造路径**把 manifest 走一遍：
 * 能在模型面前立起来才算通过，立不起来就别发布。
 *
 * 拦的是「manifest 校验通过、但送到模型端会被拒」的那一类，08-23 事故就是这一类
 * （OpenAI 拒绝含 Unicode property escapes 的 `pattern`）：
 * 1. 工具名 `app__<systemId>__<capabilityId>` 能生成且 ≤ 64 字符、组内唯一；
 * 2. `inputSchema` 能原样作为 `parametersJsonSchema` 透传，且不含
 *    **Unicode property escapes / lookbehind / 命名组**这三类正则构造
 *    （施工总则的模型可见 JSON Schema 硬约束），也不含 `$ref/allOf/anyOf/oneOf/not/if`；
 * 3. 描述符能构造出来（走 `toDescriptor`，与运行时**同一段代码**，不另写一份）。
 *
 * 失败即 throw —— `runKyAppToolRegistrationDryRun` 把异常翻成 `{status:'failed'}`。
 */
import { toolName as buildAppToolName } from '@kaiyan/ky-app-contract';

import type { Manifest, ManifestCapability } from '@kaiyan/ky-app-contract';

import type { KyAppToolRegistrationDryRun } from '../systems/publishGate.js';
import { toDescriptor } from './toolProvider.js';

/** §4.5：工具名 ≤ 64。 */
const MAX_TOOL_NAME_LENGTH = 64;

/** §4.5：description ≤ 300 字。 */
const MAX_DESCRIPTION_LENGTH = 300;

/**
 * 模型端会拒绝的正则构造。**这三类必须按源文本判定**，不能靠 `new RegExp` 试编译
 * ——Node 能编译的，OpenAI 未必接受（08-23 事故的教训）。
 */
const FORBIDDEN_REGEX_PATTERNS: ReadonlyArray<{ label: string; test: RegExp }> = [
  { label: 'Unicode property escapes（\\p{…}）', test: /\\[pP]\{/u },
  { label: 'lookbehind（(?<= 或 (?<!）', test: /\(\?<[=!]/u },
  { label: '命名组（(?<name>）', test: /\(\?<[A-Za-z_$]/u },
];

/** §4.5 能力 schema 子集里明令禁止的关键字。 */
const FORBIDDEN_SCHEMA_KEYWORDS = [
  '$ref',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'if',
  'then',
  'else',
  'format',
  'pattern',
] as const;

function assertSchemaSafe(node: unknown, path: string, capabilityId: string): void {
  if (Array.isArray(node)) {
    node.forEach((item, index) => assertSchemaSafe(item, `${path}[${index}]`, capabilityId));
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  const record = node as Record<string, unknown>;
  for (const keyword of FORBIDDEN_SCHEMA_KEYWORDS) {
    if (keyword in record) {
      throw new Error(
        `能力 ${capabilityId} 的 inputSchema 在 ${path} 使用了模型端不接受的关键字 ${keyword}`,
      );
    }
  }
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'string') {
      for (const forbidden of FORBIDDEN_REGEX_PATTERNS) {
        if (forbidden.test.test(value)) {
          throw new Error(
            `能力 ${capabilityId} 的 inputSchema 在 ${path}.${key} 含${forbidden.label}，模型端会拒绝注册`,
          );
        }
      }
      continue;
    }
    assertSchemaSafe(value, `${path}.${key}`, capabilityId);
  }
}

function readCapabilities(manifest: Manifest): ManifestCapability[] {
  const capabilities = (manifest as { capabilities?: unknown }).capabilities;
  return Array.isArray(capabilities) ? (capabilities as ManifestCapability[]) : [];
}

/**
 * 对一份 manifest 跑注册 dry-run。**只读**，不写库、不发出站、不碰任何会话。
 * 失败即抛错，异常消息进版本行的门禁结论，给发布人看。
 */
export function dryRunToolRegistration(manifest: Manifest): void {
  const systemId = (manifest as { systemId?: unknown }).systemId;
  if (typeof systemId !== 'string' || !systemId) {
    throw new Error('manifest 缺少 systemId，无法生成工具名');
  }
  const capabilities = readCapabilities(manifest);
  const seen = new Set<string>();
  for (const capability of capabilities) {
    let name: string;
    try {
      name = buildAppToolName(systemId, capability.id);
    } catch (error) {
      throw new Error(
        `能力 ${capability.id} 无法生成合法工具名：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (name.length > MAX_TOOL_NAME_LENGTH) {
      throw new Error(`能力 ${capability.id} 的工具名 ${name} 超过 ${MAX_TOOL_NAME_LENGTH} 字符`);
    }
    if (seen.has(name)) {
      throw new Error(`工具名 ${name} 在同一系统内重复（systemId/capabilityId 规范化后撞名）`);
    }
    seen.add(name);
    if ((capability.description ?? '').length > MAX_DESCRIPTION_LENGTH) {
      throw new Error(`能力 ${capability.id} 的 description 超过 ${MAX_DESCRIPTION_LENGTH} 字`);
    }
    assertSchemaSafe(capability.inputSchema, 'inputSchema', capability.id);

    // 与运行时同一段构造代码：这里立不起来，模型面前也立不起来。
    toDescriptor({
      installationId: 'dry-run',
      systemId,
      systemName: (manifest as { name?: string }).name ?? systemId,
      capabilityId: capability.id,
      toolName: name,
      capabilityName: capability.name,
      description: capability.description,
      riskLevel: capability.riskLevel,
      safeToRetry: capability.safeToRetry,
      inputSchema: capability.inputSchema as Record<string, unknown>,
      registeredDigest: '0'.repeat(64),
      baseUrl: 'https://dry-run.invalid',
    });
  }
}

/** 发布门禁用的钩子形态（`publishGate.ts:28` 的 `KyAppToolRegistrationDryRun`）。 */
export function createKyAppToolRegistrationDryRun(): KyAppToolRegistrationDryRun {
  return async (manifest: Manifest) => {
    dryRunToolRegistration(manifest);
  };
}
