import type {
  AgentTarget,
  AgentTargetCatalog,
  AgentTargetOption,
  OrgAgentSummary,
} from '@agent/shared';

/**
 * Agent 目标的呈现/寻址纯逻辑：目录裁剪、展示名、稳定自动化 id。
 *
 * 说明：`dropdown-action-*` 前缀是 Maestro flow（03-agent-switch）已固化的稳定 id，
 * Agent 切换从 ModelPicker 下钻搬到独立 sheet 后仍必须保持同一串，因此这里
 * 保留原来的派生规则，不随宿主组件改名。
 */

export type AgentTargetCatalogOption = AgentTargetOption<OrgAgentSummary> | AgentTargetOption;

export interface AgentTargetChoice {
  /** 动作 id，形如 `_agent:personal` / `_agent:<orgAgentId>` */
  actionId: string;
  testID: string;
  target: AgentTarget;
  label: string;
  description?: string;
}

const DEFAULT_ORG_AGENT_NAME = '企业专家';

export function agentTargetActionId(target: AgentTarget): string {
  return target.kind === 'personal' ? '_agent:personal' : `_agent:${target.orgAgentId}`;
}

/** 与 `DropdownMenu` 的派生规则逐字一致：非字母数字压成 `-`，首尾 `-` 去掉。 */
export function agentTargetTestID(target: AgentTarget): string {
  const slug = agentTargetActionId(target)
    .replace(/[^A-Za-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '');
  return `dropdown-action-${slug}`;
}

function optionPresentation(option: AgentTargetCatalogOption): OrgAgentSummary | undefined {
  return option.presentation as OrgAgentSummary | undefined;
}

export function agentTargetLabel(option: AgentTargetCatalogOption): string {
  if (option.target.kind === 'personal') return '个人 Agent';
  return optionPresentation(option)?.name ?? DEFAULT_ORG_AGENT_NAME;
}

export function agentTargetDescription(option: AgentTargetCatalogOption): string | undefined {
  if (option.target.kind === 'personal') return '你的个人通用 Agent';
  return optionPresentation(option)?.description || '由组织统一配置的企业专家';
}

/** 只留可用目标（与 Web OrgAgentPickerDialog 只列可选专家一致）。 */
export function listAgentTargetChoices(
  catalog: AgentTargetCatalog<OrgAgentSummary> | null | undefined,
): AgentTargetChoice[] {
  if (!catalog) return [];
  const options: AgentTargetCatalogOption[] = [catalog.personal, ...catalog.orgAgents];
  return options
    .filter((option) => option.availability.status === 'available')
    .map((option) => ({
      actionId: agentTargetActionId(option.target),
      testID: agentTargetTestID(option.target),
      target: option.target,
      label: agentTargetLabel(option),
      description: agentTargetDescription(option),
    }));
}

/** 从 `_agent:*` 动作 id 反查目标；找不到（已下架/不可用）返回 null。 */
export function resolveAgentTargetByActionId(
  catalog: AgentTargetCatalog<OrgAgentSummary> | null | undefined,
  actionId: string,
): AgentTarget | null {
  return (
    listAgentTargetChoices(catalog).find((choice) => choice.actionId === actionId)?.target ?? null
  );
}
