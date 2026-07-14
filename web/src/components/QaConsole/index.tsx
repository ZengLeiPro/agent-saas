import { useEffect, useState } from 'react';
import { MessageSquareText, ShieldAlert, ThumbsDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { authFetch } from '@/lib/authFetch';
import { cn } from '@/lib/utils';
import type { OrgAgentRecord } from '@agent/shared';
import { SessionsView } from './SessionsView';
import { GuardrailEventsView } from './GuardrailEventsView';
import { FeedbackView } from './FeedbackView';

type QaView = 'sessions' | 'guardrail' | 'feedback';

const QA_VIEWS: Array<{ id: QaView; label: string; icon: typeof MessageSquareText }> = [
  { id: 'sessions', label: '会话记录', icon: MessageSquareText },
  { id: 'guardrail', label: '门禁日志', icon: ShieldAlert },
  { id: 'feedback', label: '用户反馈', icon: ThumbsDown },
];

/**
 * 组织对话质检台（组织分析第 4 个 header tab「对话质检」，2026-07 唯恩批次）
 *
 * 三个子视图：专职 Agent 会话记录（cursor 分页 + 详情弹窗）/ 门禁拒绝日志 /
 * 用户反馈标注。过滤器的 Agent 下拉共享一次 /api/org-agents 拉取。
 */
export function QaConsole({ tenantId }: { tenantId?: string }) {
  const [view, setView] = useState<QaView>('sessions');
  const [orgAgents, setOrgAgents] = useState<OrgAgentRecord[]>([]);

  useEffect(() => {
    let cancelled = false;
    const query = tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : '';
    authFetch(`/api/org-agents${query}`)
      .then(async (res) => (res.ok ? await res.json() : []))
      .then((data) => {
        if (!cancelled) setOrgAgents(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (!cancelled) setOrgAgents([]);
      });
    return () => { cancelled = true; };
  }, [tenantId]);

  return (
    <div className="w-full space-y-4">
      <nav className="flex items-center gap-1" aria-label="质检台子视图">
        {QA_VIEWS.map((item) => {
          const Icon = item.icon;
          const selected = item.id === view;
          return (
            <Button
              key={item.id}
              type="button"
              size="sm"
              variant={selected ? 'default' : 'ghost'}
              onClick={() => setView(item.id)}
              className={cn('h-8 shrink-0 gap-1.5 px-2.5 text-xs')}
            >
              <Icon className="size-3.5" />
              {item.label}
            </Button>
          );
        })}
      </nav>

      {view === 'sessions' && <SessionsView tenantId={tenantId} orgAgents={orgAgents} />}
      {view === 'guardrail' && <GuardrailEventsView tenantId={tenantId} orgAgents={orgAgents} />}
      {view === 'feedback' && <FeedbackView tenantId={tenantId} orgAgents={orgAgents} />}
    </div>
  );
}
