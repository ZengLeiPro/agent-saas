import { useState } from 'react';
import { ChevronRight, ExternalLink, TimerOff } from 'lucide-react';
import { StatusIcons } from '@/lib/icons';
import type { SubagentStatus } from '@agent/shared';
import { cn } from '@/lib/utils';
import { activityStatusIconClass, formatActivityDuration } from './activityStatusStyles';
import { SubagentTranscriptDialog } from './SubagentTranscriptDialog';

export interface SubagentBlockProps {
  agentType: string;
  status: SubagentStatus;
  childSessionId?: string;
  childRunId?: string;
  model?: string;
  durationMs?: number;
  totalTokens?: number;
  toolUseCount?: number;
  turnCount?: number;
  errorMessage?: string;
  resultPreview?: string;
}

function statusLabel(status: SubagentStatus): string {
  if (status === 'running') return '执行中';
  if (status === 'failed') return '未完成';
  if (status === 'cancelled') return '已取消';
  if (status === 'timeout') return '超时';
  return '已完成';
}

function StatusIcon({ status }: { status: SubagentStatus }) {
  const base = 'h-3.5 w-3.5 shrink-0';
  if (status === 'running') return <StatusIcons.running className={activityStatusIconClass('active', `${base} animate-spin`)} />;
  if (status === 'failed') return <StatusIcons.error className={activityStatusIconClass('warning', base)} />;
  if (status === 'cancelled') return <StatusIcons.cancelled className={activityStatusIconClass('neutral', base)} />;
  if (status === 'timeout') return <TimerOff className={activityStatusIconClass('warning', base)} />;
  return <StatusIcons.success className={activityStatusIconClass('success', base)} />;
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export function SubagentBlock(props: SubagentBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const hasDetails = Boolean(
    props.childSessionId
    || props.childRunId
    || props.model
    || props.errorMessage
    || props.resultPreview
    || typeof props.durationMs === 'number'
    || typeof props.totalTokens === 'number'
    || typeof props.toolUseCount === 'number'
    || typeof props.turnCount === 'number',
  );

  return (
    <div className="my-0.5 min-w-0 text-sm text-muted-foreground">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        disabled={!hasDetails}
        aria-expanded={expanded}
        className={cn(
          'flex w-full min-w-0 items-center gap-1.5 py-0.5 text-left transition-colors',
          hasDetails && 'hover:text-foreground',
        )}
      >
        <StatusIcon status={props.status} />
        <span className="min-w-0 flex-1 truncate">子任务 {props.agentType}</span>
        <span className="shrink-0 text-[11px]">{statusLabel(props.status)}</span>
        {hasDetails && <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 transition-transform', expanded && 'rotate-90')} />}
      </button>

      {expanded && hasDetails && (
        <div className="ml-5 mt-1 space-y-2 rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs">
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
            {props.model && <span>模型 {props.model}</span>}
            {typeof props.durationMs === 'number' && <span>耗时 {formatActivityDuration(props.durationMs)}</span>}
            {typeof props.turnCount === 'number' && <span>{props.turnCount} turns</span>}
            {typeof props.toolUseCount === 'number' && <span>{props.toolUseCount} 次工具</span>}
            {typeof props.totalTokens === 'number' && <span>{formatCount(props.totalTokens)} tokens</span>}
          </div>
          {props.errorMessage && (
            <div className="rounded-md border border-destructive/25 bg-destructive/5 px-2 py-1.5 text-destructive">
              {props.errorMessage}
            </div>
          )}
          {props.resultPreview && (
            <div className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-background/70 px-2 py-1.5 leading-5 text-foreground/80">
              {props.resultPreview}
            </div>
          )}
          {props.childSessionId && (
            <button
              type="button"
              onClick={() => setShowTranscript(true)}
              className="inline-flex items-center gap-1 font-medium text-brand-600 transition-colors hover:text-brand-700"
            >
              查看完整过程
              <ExternalLink className="h-3 w-3" />
            </button>
          )}
        </div>
      )}

      {props.childSessionId && (
        <SubagentTranscriptDialog
          open={showTranscript}
          childSessionId={props.childSessionId}
          title={props.agentType}
          onClose={() => setShowTranscript(false)}
        />
      )}
    </div>
  );
}
