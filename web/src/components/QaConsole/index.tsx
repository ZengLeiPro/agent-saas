import { useCallback, useEffect, useState } from 'react';
import { LayoutDashboard, MessageSquareText, ShieldAlert, ThumbsDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { HISTORY_PUSH, useAdminUrlQuery } from '@/hooks/useAdminUrlQuery';
import { authFetch } from '@/lib/authFetch';
import { cn } from '@/lib/utils';
import type { OrgAgentRecord } from '@agent/shared';
import { SessionsView } from './SessionsView';
import { GuardrailEventsView } from './GuardrailEventsView';
import { GuardrailBoardView } from './GuardrailBoardView';
import { FeedbackView } from './FeedbackView';

type QaView = 'sessions' | 'guardrail' | 'board' | 'feedback';

const QA_VIEWS: Array<{ id: QaView; label: string; icon: typeof MessageSquareText }> = [
  { id: 'sessions', label: '会话记录', icon: MessageSquareText },
  { id: 'guardrail', label: '门禁日志', icon: ShieldAlert },
  { id: 'board', label: '门禁看板', icon: LayoutDashboard },
  { id: 'feedback', label: '用户反馈', icon: ThumbsDown },
];

/** URL 参数契约：`qa*` 命名空间前缀；默认视图不写进 URL */
const QA_VIEW_KEY = 'qaView';
const DEFAULT_QA_VIEW: QaView = 'sessions';
const QA_VIEW_IDS: ReadonlySet<string> = new Set(QA_VIEWS.map((item) => item.id));

function parseQaView(raw: string | null): QaView {
  return raw && QA_VIEW_IDS.has(raw) ? (raw as QaView) : DEFAULT_QA_VIEW;
}

/**
 * 组织对话质检台（组织分析第 4 个 header tab「对话质检」，2026-07 唯恩批次）
 *
 * 四个子视图：专职 Agent 会话记录（cursor 分页 + 详情弹窗）/ 门禁拒绝日志 /
 * 门禁看板（shadow 数据看板 4 视图，B4 § 4.4.4）/ 用户反馈标注。
 * 过滤器的 Agent 下拉共享一次 /api/org-agents 拉取。
 */
export function QaConsole({ tenantId }: { tenantId?: string }) {
  // 视图切换进 URL：改造前是本机 useState，刷新回到第一个子视图，也无法把「门禁看板」链接发出去
  const url = useAdminUrlQuery();
  const view = parseQaView(url.get(QA_VIEW_KEY));
  const setView = useCallback(
    (next: QaView) => url.set(QA_VIEW_KEY, next === DEFAULT_QA_VIEW ? null : next, HISTORY_PUSH),
    [url],
  );
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
      {view === 'board' && <GuardrailBoardView tenantId={tenantId} orgAgents={orgAgents} />}
      {view === 'feedback' && <FeedbackView tenantId={tenantId} orgAgents={orgAgents} />}
    </div>
  );
}
