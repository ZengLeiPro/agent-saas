/**
 * 能力中心四 Tab 的纯判定 —— 对齐 Web `CapabilityCenter/navigation.ts` +
 * `CapabilityTabsList.tsx` + `CapabilityCenter/index.tsx` 的三段语义：
 *
 * 1. Tab 顺序与文案：工作流 / 技能 / 连接器 / 专家（Web `CAPABILITY_TABS`）；
 * 2. `personalAgentEnabled=false` 时隐藏「工作流」（Web `showTemplates`）；
 * 3. 每个 Tab 在两种租户形态下渲染什么内容（Web `TabsContent` 内的三种分支）：
 *    - 技能：开放个人 Agent 才有目录，否则 `ManagedCapabilityNotice`；
 *    - 连接器：开放时是完整目录（内置卡 + 自定义 MCP），未开放时只留内置卡 + 提示，
 *      因为内置协同办公连接跟随用户 workspace，企业专家会话同样使用；
 *    - 专家：与租户形态无关，恒为目录。
 *
 * 纯函数、无 React / RN 依赖，可在 node 环境 vitest 直接跑。
 */

export type CapabilityTab = 'workflows' | 'skills' | 'connectors' | 'experts';

export interface CapabilityTabDescriptor {
  value: CapabilityTab;
  label: string;
  /** expo-router 路由（不带前导 `/` 时由调用方补全） */
  route: string;
}

/** Web `CAPABILITY_TABS` 的顺序与文案，逐条对齐。 */
export const CAPABILITY_TABS: readonly CapabilityTabDescriptor[] = [
  { value: 'workflows', label: '工作流', route: '/capabilities/workflows' },
  { value: 'skills', label: '技能', route: '/capabilities/skills' },
  { value: 'connectors', label: '连接器', route: '/capabilities/connectors' },
  { value: 'experts', label: '专家', route: '/capabilities/experts' },
];

/** 未开放个人通用 Agent 的租户没有工作流目录（Web `showTemplates=false`）。 */
export function capabilityTabsFor(personalAgentEnabled: boolean): CapabilityTabDescriptor[] {
  return CAPABILITY_TABS.filter((tab) => personalAgentEnabled || tab.value !== 'workflows');
}

/** 默认落地 Tab：能看工作流就落工作流，否则落专家（Web 同一优先级）。 */
export function defaultCapabilityTab(personalAgentEnabled: boolean): CapabilityTab {
  return personalAgentEnabled ? 'workflows' : 'experts';
}

/** 路由段 / 查询参数归一到合法 Tab；非法值与被隐藏的 Tab 一律回落默认值。 */
export function normalizeCapabilityTab(
  raw: string | undefined | null,
  personalAgentEnabled: boolean,
): CapabilityTab {
  const matched = capabilityTabsFor(personalAgentEnabled).find((tab) => tab.value === raw);
  return matched?.value ?? defaultCapabilityTab(personalAgentEnabled);
}

/**
 * Tab 内容形态：
 * - `catalog`：完整目录；
 * - `built-in-only`：只保留内置连接器卡 + 「由组织统一配置」提示；
 * - `managed-notice`：整页替换为「由组织统一配置」提示；
 * - `hidden`：该租户下不应出现此 Tab。
 */
export type CapabilityTabContent = 'catalog' | 'built-in-only' | 'managed-notice' | 'hidden';

export function capabilityTabContent(
  tab: CapabilityTab,
  personalAgentEnabled: boolean,
): CapabilityTabContent {
  if (personalAgentEnabled) return 'catalog';
  if (tab === 'workflows') return 'hidden';
  if (tab === 'skills') return 'managed-notice';
  if (tab === 'connectors') return 'built-in-only';
  return 'catalog';
}
