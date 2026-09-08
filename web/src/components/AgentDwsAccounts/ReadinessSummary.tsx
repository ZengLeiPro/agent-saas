import type { AgentDwsReadiness } from '@agent/shared/types/agentDwsAccount';

import { Badge } from '@/components/ui/badge';

const FIX_TARGET_LABEL: Record<string, string> = {
  account_authorization: '账号授权',
  stream_runtime: '消息监听',
  agent_settings: '组织 Agent 设置',
  runtime_compatibility: '运行环境',
  group_binding: '群配置',
  context_settings: 'Context 配置',
  capability_settings: '能力配置',
  delivery_settings: '完成反馈',
};

export function ReadinessSummary({ readiness }: { readiness?: AgentDwsReadiness }) {
  if (!readiness) return null;
  const issues = readiness.checks.filter((check) => check.severity !== 'ready');
  const presentation =
    readiness.status === 'ready'
      ? { label: '已就绪', variant: 'success' as const }
      : readiness.status === 'blocked'
        ? { label: '尚未就绪', variant: 'danger' as const }
        : { label: '待确认', variant: 'warning' as const };
  return (
    <div className="mt-2 space-y-1" data-testid="dws-readiness">
      <Badge variant={presentation.variant}>{presentation.label}</Badge>
      {issues.map((issue) => (
        <p key={issue.code} className="max-w-72 whitespace-normal text-xs text-muted-foreground">
          {issue.message}；请检查{FIX_TARGET_LABEL[issue.fixTarget] ?? '相关配置'}
        </p>
      ))}
    </div>
  );
}
