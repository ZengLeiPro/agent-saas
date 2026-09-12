import { readTenantCompanyInfoSync } from '../../data/tenants/companyInfo.js';
import type { SubagentTypeDefinition } from './agentTypes.js';

export function buildSubagentInstructions(args: {
  agentType: SubagentTypeDefinition;
  cwd: string;
  executionTarget: string;
  modelRef: string;
  effort?: string;
  agentId: string;
  continuation: boolean;
  enterpriseAttempt: boolean;
  companyInfo?: string;
  systemPrompt?: string;
  profileSystemInstructions?: string;
  orgAgentName?: string;
  orgAgentInstructions?: string;
  memoryReadOnly?: boolean;
}): string {
  const sections: string[] = [args.systemPrompt ?? args.agentType.systemPrompt];
  if (args.profileSystemInstructions?.trim()) {
    sections.push(
      `<agent-profile-instructions>\n${args.profileSystemInstructions.trim()}\n</agent-profile-instructions>`,
    );
  }
  if (args.orgAgentInstructions?.trim()) {
    sections.push(
      [
        '<org-agent-worker-policy>',
        `你是组织 Agent「${args.orgAgentName ?? '未命名'}」派生的执行 Worker，不承担前台接待或再次派单。`,
        '以下组织规则继续约束你的执行；其中若包含“只负责调度”等前台职责，以本段 Worker 角色为准。',
        args.orgAgentInstructions.trim(),
        '</org-agent-worker-policy>',
      ].join('\n'),
    );
  }
  sections.push(
    [
      '<env>',
      `逻辑身份: ${args.agentId}`,
      `运行形态: ${args.continuation ? '续接 run；此前完整子会话历史已作为上下文恢复，不得重放历史工具副作用' : '首次 run'}`,
      `模型: ${args.modelRef}；effort: ${args.effort ?? '未设置'}`,
      `工作目录: ${args.cwd}`,
      `工作区类型: ${args.enterpriseAttempt ? '企业工作单 attempt 工作区；旧 attempt 产物只读，以本 attempt 发布为准' : '普通会话 workspace；与主 Agent 共享文件可见性'}`,
      `执行环境: ${args.executionTarget}`,
      'Shell 在子 Agent 中仅允许 foreground；不要使用 mode="background"。',
      ...(args.memoryReadOnly
        ? [
            '记忆空间只读：只能用 MemorySearch/Read 查询，不得通过 Write/Edit/Shell 修改 MEMORY.md 或 memory/**。',
          ]
        : []),
      `当前时间: ${new Date().toISOString()}`,
      '</env>',
    ].join('\n'),
  );
  if (args.companyInfo) sections.push(`<company-info>\n${args.companyInfo}\n</company-info>`);
  return sections.join('\n\n');
}

export function loadCompanyInfoForSubagent(
  sharedDir: string,
  tenantId: string | undefined,
): string | undefined {
  if (!tenantId) return undefined;
  try {
    const content = readTenantCompanyInfoSync(sharedDir, tenantId)?.trim();
    return content || undefined;
  } catch {
    return undefined;
  }
}
