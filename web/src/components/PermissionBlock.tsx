import { lazy, Suspense, useState } from 'react';
import { Shield, Check, X, ChevronDown, ChevronUp } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { loadMarkdownRuntime } from '@/lib/markdownRuntime';
import { extractTextFromChildren, getCellMinWidthPx } from '@/lib/tableCellWidth';
import { truncateContent } from './types';
import { deriveConfirmationCard, isAppCapabilityToolName } from './appConfirmation';
import type { WsToolConfirmationCard } from '@agent/shared';
import 'katex/dist/katex.min.css';

const LazyAppConfirmationCard = lazy(async () => {
  const { AppConfirmationCard } = await import('./AppConfirmationCard');
  return { default: AppConfirmationCard };
});

const LazyMarkdown = lazy(async () => {
  const { Markdown, remarkPlugins, rehypePlugins } = await loadMarkdownRuntime();
  const mdComponents: import('react-markdown').Components = {
    a: ({ children, href, ...props }) => (
      <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
        {children}
      </a>
    ),
    table: ({ children, ...props }) => (
      <div className="overflow-x-auto">
        <table {...props}>{children}</table>
      </div>
    ),
    td: ({ children, style, ...props }) => (
      <td
        style={{ minWidth: `${getCellMinWidthPx(extractTextFromChildren(children))}px`, ...style }}
        {...props}
      >
        {children}
      </td>
    ),
    th: ({ children, style, ...props }) => (
      <th
        style={{ minWidth: `${getCellMinWidthPx(extractTextFromChildren(children))}px`, ...style }}
        {...props}
      >
        {children}
      </th>
    ),
  };
  return {
    default: ({ content }: { content: string }) => (
      <Markdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={mdComponents}
      >
        {content}
      </Markdown>
    ),
  };
});

/** 规划方案审批的 toolName（由 resolvePlanModeDisplay 映射） */
const PLAN_REVIEW_NAME = '规划方案审批';

interface PermissionBlockProps {
  toolName: string;
  toolInput: string;
  status: 'pending' | 'allowed' | 'denied';
  onAllow: () => void;
  onDeny: () => void;
  disabled?: boolean;
  error?: string;
  /**
   * WP3 §6.2-2 的确认卡片。服务端 ws `permission_request.confirmation` 透传；
   * 缺失时对 `app__` 工具按工具名与入参兜底推导（绝不退回无二次确认的两键卡片）。
   */
  confirmation?: WsToolConfirmationCard;
}

export function PermissionBlock({
  toolName,
  toolInput,
  status,
  onAllow,
  onDeny,
  disabled = false,
  error,
  confirmation,
}: PermissionBlockProps) {
  const isPlanReview = toolName === PLAN_REVIEW_NAME && toolInput.length > 100;
  const appCard =
    confirmation ??
    (isAppCapabilityToolName(toolName) ? deriveConfirmationCard(toolName, toolInput) : undefined);
  const [expanded, setExpanded] = useState(isPlanReview);

  const renderContent = () => {
    if (isPlanReview) {
      return (
        <div
          className={`prose prose-sm dark:prose-invert max-w-none mb-3 overflow-y-auto ${expanded ? 'max-h-[60vh]' : 'max-h-48'}`}
        >
          <Suspense fallback={<pre className="code-preview">{toolInput.slice(0, 500)}...</pre>}>
            <LazyMarkdown content={toolInput} />
          </Suspense>
        </div>
      );
    }
    const { text: displayText } = truncateContent(toolInput, 6);
    return <pre className="code-preview mb-3 max-h-48">{displayText}</pre>;
  };

  return (
    <Card className="border-border bg-accent/50">
      <div className="flex items-center justify-between gap-2 px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Shield aria-hidden="true" className="size-4 text-primary" />
          <span className="text-sm font-medium">Permission: {toolName}</span>
        </div>
        <div className="flex items-center gap-2">
          {isPlanReview && (
            <button
              className="rounded-md p-1 text-muted-foreground/50 transition-colors hover:text-muted-foreground"
              onClick={() => setExpanded(!expanded)}
              title={expanded ? '收起' : '展开'}
            >
              {expanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
            </button>
          )}
          {status === 'allowed' && <Badge className="bg-success/10 text-success">Allowed</Badge>}
          {status === 'denied' && (
            <Badge className="bg-destructive/10 text-destructive">Denied</Badge>
          )}
        </div>
      </div>
      <CardContent className="pb-3 pt-0">
        {appCard ? (
          <Suspense fallback={<p className="text-sm text-muted-foreground">正在加载确认信息…</p>}>
            <LazyAppConfirmationCard
              card={appCard}
              status={status}
              disabled={disabled}
              onAllow={onAllow}
              onDeny={onDeny}
            />
          </Suspense>
        ) : null}
        {appCard ? null : renderContent()}
        {!appCard && status === 'pending' && (
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="min-h-11 text-primary border-primary/30 hover:bg-primary/5"
              disabled={disabled}
              aria-label="Allow"
              onClick={onAllow}
            >
              <Check aria-hidden="true" className="size-3.5" />
              Allow
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="min-h-11 text-destructive border-destructive/30 hover:bg-destructive/5"
              disabled={disabled}
              aria-label="Deny"
              onClick={onDeny}
            >
              <X aria-hidden="true" className="size-3.5" />
              Deny
            </Button>
          </div>
        )}
        {error ? (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
