import { useState, memo } from 'react';
import { Loader2, CheckCircle2, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getToolDisplayInfo } from '@agent/shared';
import { MessageItem } from './types';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolBlock, ToolResultBlock } from './ToolBlock';
import { SubagentBlock } from './SubagentBlock';

interface SummaryInfo {
  text: string;
  truncateStart: boolean;
}

/** 根据最后一条消息生成摘要文字及截断方向 */
function getSummary(item: MessageItem): SummaryInfo {
  switch (item.type) {
    case 'thinking':
      return { text: item.streaming ? '思考中...' : '已思考', truncateStart: false };
    case 'tool_use': {
      const info = getToolDisplayInfo(item.toolName, item.toolInput);
      const label = info.detail ? `${info.name}: ${info.detail}` : info.name;
      const text = item.streaming ? `${label}...` : label;
      return { text, truncateStart: info.detailTruncate === 'start' };
    }
    case 'tool_result':
      return { text: `Result: ${item.toolName}`, truncateStart: false };
    case 'subagent':
      return { text: item.status === 'running' ? `子任务 ${item.agentType}...` : `子任务 ${item.agentType}`, truncateStart: false };
    default:
      return { text: '', truncateStart: false };
  }
}

function ActivityItem({ item }: { item: MessageItem }) {
  switch (item.type) {
    case 'thinking':
      return <ThinkingBlock content={item.content} streaming={item.streaming} />;
    case 'tool_use':
      return <ToolBlock toolName={item.toolName} toolInput={item.toolInput} streaming={item.streaming} result={item.result} resultReady={item.resultReady} />;
    case 'tool_result':
      return <ToolResultBlock toolName={item.toolName} result={item.result} />;
    case 'subagent':
      return <SubagentBlock agentType={item.agentType} status={item.status} />;
    default:
      return null;
  }
}

interface ActivityGroupBlockProps {
  items: MessageItem[];
  isActive: boolean;
  isLast?: boolean;
  debugMode?: boolean;
}

export function ExecutionHiddenPlaceholder({ isActive }: { isActive?: boolean }) {
  return (
    <div className="my-0.5 flex items-center gap-1.5 py-0.5 text-sm text-muted-foreground">
      {isActive ? (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
      ) : (
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
      )}
      <span>{isActive ? "正在执行中" : "已执行"}</span>
    </div>
  );
}

export const ActivityGroupBlock = memo(function ActivityGroupBlock({ items, isActive, debugMode = true }: ActivityGroupBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (!debugMode) {
    return <ExecutionHiddenPlaceholder isActive={isActive} />;
  }

  // 单项分组：直接渲染子项本身（单层展开），不套分组壳
  if (items.length === 1) {
    return <ActivityItem item={items[0]} />;
  }

  const lastItem = items[items.length - 1];
  const summary = getSummary(lastItem);

  return (
    <div className="my-0.5">
      <button
        onClick={() => setIsExpanded(v => !v)}
        className="flex max-w-full items-center gap-1.5 py-0.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        {isActive ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
        )}
        <span
          className="min-w-0 max-w-sm truncate"
          style={summary.truncateStart ? { direction: 'rtl', textAlign: 'left' } : undefined}
        >{summary.text}</span>
        <span className="shrink-0 text-muted-foreground/60">({items.length})</span>
        <ChevronRight className={cn(
          "h-3.5 w-3.5 shrink-0 transition-transform",
          isExpanded && "rotate-90",
        )} />
      </button>
      {isExpanded && (
        <div className="ml-5 flex flex-col border-l border-border pl-2 [&>*]:my-0" style={{ gap: 10, paddingTop: 10 }}>
          {items.map(item => (
            <ActivityItem key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
});
