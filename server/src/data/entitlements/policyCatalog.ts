import type { TenantPolicyKey } from './types.js';

export type TenantPolicyGroup =
  | 'agents_automation'
  | 'connectors_data'
  | 'knowledge_memory'
  | 'models_tools'
  | 'security_session';

export interface TenantPolicyDefinition {
  label: string;
  description: string;
  group: TenantPolicyGroup;
  groupLabel: string;
  valueType: 'boolean' | 'enum';
  options?: Array<{ value: string; label: string }>;
}

const groupLabels: Record<TenantPolicyGroup, string> = {
  agents_automation: '智能体与自动化',
  connectors_data: '连接器与数据',
  knowledge_memory: '知识与记忆',
  models_tools: '模型与工具',
  security_session: '安全与会话',
};

function booleanPolicy(
  label: string,
  description: string,
  group: TenantPolicyGroup,
): TenantPolicyDefinition {
  return { label, description, group, groupLabel: groupLabels[group], valueType: 'boolean' };
}

export const TENANT_POLICY_DEFINITIONS: Record<TenantPolicyKey, TenantPolicyDefinition> = {
  'agent.personal.enabled': booleanPolicy('个人智能体', '允许成员创建和使用个人智能体。', 'agents_automation'),
  'automation.cron.enabled': booleanPolicy('自动化任务', '允许成员创建和运行定时自动化任务。', 'agents_automation'),
  'connector.global_servers.allowed': booleanPolicy('平台连接器', '允许组织成员使用平台统一提供的连接器服务。', 'connectors_data'),
  'connector.mcp.enabled': booleanPolicy('MCP 连接器', '允许组织使用 MCP 连接器能力。', 'connectors_data'),
  'connector.personal_oauth.allowed': booleanPolicy('个人 OAuth 授权', '允许成员绑定个人第三方账号授权。', 'connectors_data'),
  'connector.tenant_servers.allowed': booleanPolicy('组织连接器', '允许组织配置和使用本组织的连接器服务。', 'connectors_data'),
  'credential.org_shared.allowed': booleanPolicy('组织共享凭据', '允许智能体使用组织托管的共享凭据。', 'connectors_data'),
  'knowledge.org.enabled': booleanPolicy('组织知识库', '允许成员访问已获授权的组织知识资源。', 'knowledge_memory'),
  'memory.consolidation.enabled': booleanPolicy('长期记忆整理', '允许系统将会话信息整理为长期记忆。', 'knowledge_memory'),
  'memory.personal.enabled': booleanPolicy('个人记忆', '允许成员使用个人长期记忆。', 'knowledge_memory'),
  'memory.polling.billable': booleanPolicy('记忆整理计费', '记忆轮询与整理产生的消耗计入组织用量。', 'knowledge_memory'),
  'memory.polling.enabled': booleanPolicy('记忆自动整理', '允许系统按计划自动整理长期记忆。', 'knowledge_memory'),
  'memory.write_delegation.enabled': booleanPolicy('记忆委托写入', '允许运行过程将记忆写入委托给受控服务。', 'knowledge_memory'),
  'model.group_names.visible': booleanPolicy('模型分组名称', '在模型选择器中向成员显示模型分组名称。', 'models_tools'),
  'model.user_switch.allowed': booleanPolicy('成员切换模型', '允许成员在可用模型之间自行切换。', 'models_tools'),
  'org.first_day_guide_bar.enabled': booleanPolicy('新成员引导', '向首次使用的组织成员展示入门引导。', 'agents_automation'),
  'runtime.debug_mode.allowed': booleanPolicy('成员调试模式授权', '允许组织向成员开放运行细节与调试信息。', 'security_session'),
  'runtime.debug_mode.enabled': booleanPolicy('成员调试模式', '控制组织当前是否启用成员调试模式。', 'security_session'),
  'runtime.high_risk_tool.mode': {
    label: '高风险工具审批',
    description: '决定高风险工具是否必须经过运行时审批。',
    group: 'security_session',
    groupLabel: groupLabels.security_session,
    valueType: 'enum',
    options: [
      { value: 'approval', label: '要求审批' },
      { value: 'require_approval', label: '要求审批（兼容配置）' },
      { value: 'off', label: '不要求审批' },
    ],
  },
  'security.dingtalk_binding.required': booleanPolicy('要求绑定钉钉', '要求组织成员绑定钉钉身份后才能使用。', 'security_session'),
  'session.auto_compact.enabled': booleanPolicy('会话自动压缩', '上下文接近上限时自动压缩会话内容。', 'security_session'),
  'session.context_token_details.allowed': booleanPolicy('上下文用量明细', '允许成员展开查看上下文 Token 明细。', 'security_session'),
  'session.context_tokens.visible': booleanPolicy('上下文用量统计', '向成员显示会话上下文和 Token 统计。', 'security_session'),
  'session.files.enabled': booleanPolicy('会话文件', '允许成员在会话中上传和使用文件。', 'connectors_data'),
  'session.qa.mask_tool_inputs': booleanPolicy('质检隐藏工具输入', '在会话质检中隐藏工具输入的敏感内容。', 'security_session'),
  'skill.custom.enabled': booleanPolicy('自定义技能', '允许组织创建和使用自定义 Skill。', 'models_tools'),
  'skill.member_opt_in.allowed': booleanPolicy('成员自选技能', '允许成员自行启用组织提供的 Skill。', 'models_tools'),
  'tool.image_gen.enabled': booleanPolicy('图片生成工具', '允许成员使用图片生成能力。', 'models_tools'),
};

export function getTenantPolicyDefinition(policyKey: TenantPolicyKey): TenantPolicyDefinition {
  return TENANT_POLICY_DEFINITIONS[policyKey];
}
