import { useMemo, useState } from 'react';
import { AlarmClock, ChevronDown, CirclePause, CirclePlay, Pencil, Play, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AutomationControlRequest, AutomationTimelineEvent, SessionAutomationSnapshot } from '@/lib/sessionAutomation';

interface SessionAutomationCardProps {
  snapshot: SessionAutomationSnapshot;
  timeline?: AutomationTimelineEvent[];
  pending?: boolean;
  error?: string | null;
  onControl: (request: AutomationControlRequest) => Promise<void> | void;
}

const statusLabels: Readonly<Record<string, string>> = {
  active: '运行中', paused: '已暂停', blocked: '已阻塞', budget_limited: '预算受限',
  completed: '已完成', cancelled: '已取消', failed: '失败', expired: '已到期', cancelling: '正在停止',
  reconcile_required: '需要重新核对',
};

function formatNumber(value: number | undefined): string {
  if (value === undefined) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function formatTime(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function eventLabel(event: AutomationTimelineEvent): string {
  if (event.message) return event.message;
  if (event.type === 'automation_state_changed' && event.snapshot) {
    return `状态变为 ${statusLabels[event.snapshot.status] ?? event.snapshot.status}`;
  }
  return event.type.replace(/^automation_/, '').replace(/_/g, ' ');
}

export function SessionAutomationCard({ snapshot, timeline = [], pending, error, onControl }: SessionAutomationCardProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(snapshot.condition ?? snapshot.prompt ?? '');
  const paused = snapshot.status === 'paused';
  const terminal = ['completed', 'cancelled', 'failed', 'expired'].includes(snapshot.status);
  const budget = snapshot.budget;
  const nextRun = snapshot.actualNextWakeAt ?? snapshot.nextActionAt ?? snapshot.nominalNextSlotAt;
  const summary = snapshot.kind === 'goal' ? snapshot.condition : snapshot.prompt;
  const budgetItems = useMemo(() => [
    { label: '轮次', value: `${budget?.usedTurns ?? snapshot.runCount ?? 0}/${budget?.maxTurns ?? budget?.turns ?? snapshot.maxRuns ?? '∞'}` },
    { label: '模型请求', value: formatNumber(snapshot.modelRequestCount) },
    { label: 'Tokens', value: `${formatNumber(budget?.usedTokens)}/${formatNumber(budget?.maxTokens ?? budget?.tokens)}` },
    { label: 'Credits', value: `${formatNumber(budget?.usedCredits)}/${formatNumber(budget?.maxCredits ?? budget?.credits)}` },
  ], [budget, snapshot.maxRuns, snapshot.modelRequestCount, snapshot.runCount]);

  const invoke = (request: AutomationControlRequest) => void Promise.resolve(onControl(request)).catch(() => undefined);

  return (
    <section aria-label="会话自动化状态" className="shrink-0 border-b bg-background/95 px-3 py-2 backdrop-blur sm:px-5">
      <div className="content-container rounded-xl border bg-card px-3 py-3 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1 text-sm font-semibold">
                <AlarmClock className="size-4 text-primary" />
                {snapshot.kind === 'goal' ? 'Goal' : `Loop${snapshot.mode ? ` · ${snapshot.mode === 'fixed' ? '固定' : '自适应'}` : ''}`}
              </span>
              <span className={cn(
                'rounded-full px-2 py-0.5 text-[11px] font-medium',
                paused ? 'bg-warning/15 text-warning' : terminal ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-primary',
              )}>
                {statusLabels[snapshot.status] ?? snapshot.status}
              </span>
              {snapshot.phase && <span className="text-xs text-muted-foreground">{snapshot.phase}</span>}
              {snapshot.currentRunActive && paused && <span className="text-xs text-warning">当前轮仍在运行 · 不会再续跑</span>}
            </div>
            {!editing && summary && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground" title={summary}>{summary}</p>}
            {editing && (
              <div className="mt-2 flex gap-2">
                <input
                  aria-label={snapshot.kind === 'goal' ? '编辑 Goal 条件' : '编辑 Loop 提示词'}
                  className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-ring"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                />
                <button type="button" className="rounded-md bg-primary px-2 text-xs text-primary-foreground disabled:opacity-50" disabled={!draft.trim() || pending} onClick={() => { invoke({ action: 'edit', payload: snapshot.kind === 'goal' ? { condition: draft.trim() } : { prompt: draft.trim() } }); setEditing(false); }}>保存</button>
                <button type="button" className="rounded-md px-2 text-xs hover:bg-muted" onClick={() => setEditing(false)}>取消</button>
              </div>
            )}
          </div>
          <div className="flex items-center gap-1">
            {!terminal && (paused ? (
              <button type="button" disabled={pending} onClick={() => invoke({ action: 'resume' })} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"><CirclePlay className="size-3.5" />继续</button>
            ) : (
              <button type="button" disabled={pending} onClick={() => invoke({ action: 'pause' })} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"><CirclePause className="size-3.5" />暂停</button>
            ))}
            {snapshot.kind === 'loop' && !terminal && <button type="button" disabled={pending} onClick={() => invoke({ action: 'run_now' })} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"><Play className="size-3.5" />立即运行</button>}
            {!terminal && <button type="button" disabled={pending} onClick={() => { setDraft(snapshot.condition ?? snapshot.prompt ?? ''); setEditing(true); }} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"><Pencil className="size-3.5" />编辑</button>}
            {!terminal && <button type="button" disabled={pending} onClick={() => invoke({ action: 'clear' })} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"><Trash2 className="size-3.5" />停止</button>}
          </div>
        </div>

        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 border-t pt-2 text-xs sm:grid-cols-5">
          <div><span className="text-muted-foreground">下次运行</span><div className="truncate font-medium" title={nextRun ?? undefined}>{formatTime(nextRun)}</div></div>
          {budgetItems.map((item) => <div key={item.label}><span className="text-muted-foreground">{item.label}</span><div className="font-medium tabular-nums">{item.value}</div></div>)}
        </div>
        {(snapshot.latestProgress || snapshot.evaluatorReason || snapshot.latestResult) && (
          <p className="mt-2 text-xs"><span className="text-muted-foreground">最新进展：</span>{snapshot.latestProgress ?? snapshot.evaluatorReason ?? snapshot.latestResult}</p>
        )}
        {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
        {timeline.length > 0 && (
          <details className="mt-2 border-t pt-2 text-xs">
            <summary className="flex cursor-pointer list-none items-center gap-1 text-muted-foreground"><ChevronDown className="size-3" />自动化记录（{timeline.length}）</summary>
            <ol className="mt-1 max-h-24 space-y-1 overflow-auto pl-4 text-muted-foreground">
              {timeline.slice(-10).map((event) => <li key={event.eventId}>{eventLabel(event)}</li>)}
            </ol>
          </details>
        )}
      </div>
    </section>
  );
}
