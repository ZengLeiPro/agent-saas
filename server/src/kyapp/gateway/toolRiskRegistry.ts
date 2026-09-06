/**
 * WP3：`app__` 工具的风险档进程内登记表（规范 §6.1 / §6.2-1；WP3 施工总则 §3.3）。
 *
 * 为什么需要它：授权模式的自动裁决发生在 `server/src/channels/web/channel.ts` 的
 * `onInteraction` 里，那里只拿得到 `InteractionEvent`（`server/src/agent/types.ts:60-72`），
 * **不带 risk / neverAutoApprove**。而「`read_only` 放行、`external_write` 必须弹确认」
 * 是按能力的 `riskLevel` 分流的，因此需要一个「工具名 → 风险档」的查表。
 *
 * 工具名 `app__<systemId>__<capabilityId>` 全局唯一（§4.5），
 * 同一进程内 `AppCapabilityToolProvider` 构造描述符时登记，channel 侧只读查询。
 *
 * **fail-closed**：查不到（进程刚起、跨进程、快照尚未建立）时一律按 `external_write`
 * 处理 —— 宁可多弹一次确认，绝不静默自动批准外部写。
 */
import { TOOL_NAME_PREFIX } from '@kaiyan/ky-app-contract';

import type { RiskLevel } from '@kaiyan/ky-app-contract';

/** 登记表上限，防止长跑进程里无界增长（能力总量远小于这个数）。 */
const MAX_ENTRIES = 4096;

/**
 * 登记的能力元数据。除风险档外还带客户面名字 —— §6.2-2 的确认卡片要在
 * channel 侧拼「系统名 / 能力名 / 参数摘要」，而 `InteractionEvent` 里只有工具名。
 */
export interface AppCapabilityToolMeta {
  risk: RiskLevel;
  systemId: string;
  systemName: string;
  capabilityId: string;
  capabilityName: string;
  installationId: string;
}

const metaByToolName = new Map<string, AppCapabilityToolMeta>();

/** 工具名/工具 id 是否属于定制项目能力（§4.5 前缀）。 */
export function isAppCapabilityToolName(value: string | undefined | null): boolean {
  return typeof value === 'string' && value.startsWith(TOOL_NAME_PREFIX);
}

/** `AppCapabilityToolProvider` 构造描述符时登记；同名覆盖（发布门禁保证同名同义）。 */
export function rememberAppCapabilityTool(toolName: string, meta: AppCapabilityToolMeta): void {
  if (!isAppCapabilityToolName(toolName)) return;
  if (!metaByToolName.has(toolName) && metaByToolName.size >= MAX_ENTRIES) {
    // 满了就丢最早的一条：被丢掉的工具后续查不到 → fail-closed 弹确认，不会放宽。
    const oldest = metaByToolName.keys().next();
    if (!oldest.done) metaByToolName.delete(oldest.value);
  }
  metaByToolName.set(toolName, meta);
}

/** 已登记的能力元数据；未登记返回 `undefined`（调用方须 fail-closed）。 */
export function lookupAppCapabilityTool(
  toolName: string | undefined | null,
): AppCapabilityToolMeta | undefined {
  if (!isAppCapabilityToolName(toolName)) return undefined;
  return metaByToolName.get(toolName as string);
}

/** 已登记的风险档；未登记返回 `undefined`（调用方须 fail-closed）。 */
export function lookupAppCapabilityRisk(
  toolName: string | undefined | null,
): RiskLevel | undefined {
  return lookupAppCapabilityTool(toolName)?.risk;
}

/**
 * 授权模式下能否直接放行：仅 `read_only` 且**已登记**才放行。
 * 未登记 / `external_write` → false（落人工确认）。
 */
export function isAppReadOnlyTool(
  toolName: string | undefined,
  toolId?: string | undefined,
): boolean {
  const names = [toolName, toolId].filter(isAppCapabilityToolName) as string[];
  if (names.length === 0) return false;
  return names.every((name) => metaByToolName.get(name)?.risk === 'read_only');
}

/**
 * 是否是「即使授权模式开启也必须人工确认」的定制项目写能力（规范 DoD 第三条）。
 * fail-closed：`app__` 前缀但风险档未知 → true。
 */
export function requiresAppWriteConfirmation(
  toolName: string | undefined,
  toolId?: string | undefined,
): boolean {
  const isApp = isAppCapabilityToolName(toolName) || isAppCapabilityToolName(toolId);
  if (!isApp) return false;
  return !isAppReadOnlyTool(toolName, toolId);
}

/** 仅供测试：清空登记表。 */
export function resetAppCapabilityRiskRegistryForTest(): void {
  metaByToolName.clear();
}
