import { useState } from 'react';
import { PanelRight } from 'lucide-react';
import { formatTokenCount, type SubagentStatus } from '@agent/shared';
import { formatActivityDuration } from './activityStatusStyles';
import { AgentActivityShell, type AgentActivityState } from './AgentActivityShell';
import { useSubagentTranscript } from '@/contexts/SubagentTranscriptContext';

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

function activityState(status: SubagentStatus): AgentActivityState {
  if (status === 'running') return 'running';
  if (status === 'completed') return 'completed';
  if (status === 'cancelled') return 'cancelled';
  return 'failed';
}

export function SubagentBlock(props: SubagentBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const transcriptPanel = useSubagentTranscript();
  const showTranscript = () => {
    if (!props.childSessionId) return;
    transcriptPanel?.openTranscript({ childSessionId: props.childSessionId, title: props.agentType });
  };
  const meta = [
    props.model,
    typeof props.durationMs === 'number' ? formatActivityDuration(props.durationMs) : undefined,
    typeof props.totalTokens === 'number' ? `${formatTokenCount(props.totalTokens)} tokens` : undefined,
  ].filter(Boolean).join(' · ');

  return (
    <AgentActivityShell
      state={activityState(props.status)}
      title={`子任务 ${props.agentType}`}
      subtitle={props.resultPreview || props.errorMessage}
      meta={meta || undefined}
      expanded={expanded}
      onToggle={() => setExpanded((value) => !value)}
      actions={props.childSessionId && transcriptPanel ? (
        <button
          type="button"
          title="查看完整过程"
          onClick={showTranscript}
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <PanelRight className="size-3.5" />
        </button>
      ) : undefined}
    >
      <div className="space-y-2 text-xs">
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
          {props.model && <span>模型 {props.model}</span>}
          {typeof props.durationMs === 'number' && <span>耗时 {formatActivityDuration(props.durationMs)}</span>}
          {typeof props.turnCount === 'number' && <span>{props.turnCount} turns</span>}
          {typeof props.toolUseCount === 'number' && <span>{props.toolUseCount} 次工具</span>}
          {typeof props.totalTokens === 'number' && <span>{formatTokenCount(props.totalTokens)} tokens</span>}
        </div>
        {props.errorMessage && (
          <div className="rounded-md border border-destructive/25 bg-destructive/5 px-2 py-1.5 text-destructive">
            {props.errorMessage}
          </div>
        )}
        {props.resultPreview && (
          <div className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-background/70 px-2 py-1.5 leading-4 text-foreground/80">
            {props.resultPreview}
          </div>
        )}
        {props.childSessionId && transcriptPanel && (
          <button
            type="button"
            onClick={showTranscript}
            className="inline-flex items-center gap-1 font-medium text-brand-600 transition-colors hover:text-brand-700"
          >
            查看完整过程
            <PanelRight className="size-3" />
          </button>
        )}
      </div>
    </AgentActivityShell>
  );
}
