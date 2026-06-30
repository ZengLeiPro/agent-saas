import { lazy, Suspense, useState } from "react";
import { Shield, Check, X, ChevronDown, ChevronUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { extractTextFromChildren, getCellMinWidthPx } from "@/lib/tableCellWidth";
import { truncateContent } from "./types";

const markdownPromise = import("react-markdown");
const remarkGfmPromise = import("remark-gfm");
const remarkMathPromise = import("remark-math");
const rehypeKatexPromise = import("rehype-katex");
import "katex/dist/katex.min.css";

const LazyMarkdown = lazy(async () => {
  const [{ default: Markdown }, { default: remarkGfm }, { default: remarkMath }, { default: rehypeKatex }] = await Promise.all([
    markdownPromise,
    remarkGfmPromise,
    remarkMathPromise,
    rehypeKatexPromise,
  ]);
  const mdComponents: import("react-markdown").Components = {
    a: ({ children, href, ...props }) => (
      <a href={href} target="_blank" rel="noopener noreferrer" {...props}>{children}</a>
    ),
    table: ({ children, ...props }) => (
      <div className="overflow-x-auto">
        <table {...props}>{children}</table>
      </div>
    ),
    td: ({ children, style, ...props }) => (
      <td style={{ minWidth: `${getCellMinWidthPx(extractTextFromChildren(children))}px`, ...style }} {...props}>{children}</td>
    ),
    th: ({ children, style, ...props }) => (
      <th style={{ minWidth: `${getCellMinWidthPx(extractTextFromChildren(children))}px`, ...style }} {...props}>{children}</th>
    ),
  };
  return {
    default: ({ content }: { content: string }) => (
      <Markdown remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: false }]]} rehypePlugins={[rehypeKatex]} components={mdComponents}>
        {content}
      </Markdown>
    ),
  };
});

/** 规划方案审批的 toolName（由 resolvePlanModeDisplay 映射） */
const PLAN_REVIEW_NAME = "规划方案审批";

interface PermissionBlockProps {
  toolName: string;
  toolInput: string;
  status: "pending" | "allowed" | "denied";
  onAllow: () => void;
  onDeny: () => void;
}

export function PermissionBlock({ toolName, toolInput, status, onAllow, onDeny }: PermissionBlockProps) {
  const isPlanReview = toolName === PLAN_REVIEW_NAME && toolInput.length > 100;
  const [expanded, setExpanded] = useState(isPlanReview);

  const renderContent = () => {
    if (isPlanReview) {
      return (
        <div className={`prose prose-sm dark:prose-invert max-w-none mb-3 overflow-y-auto ${expanded ? "max-h-[60vh]" : "max-h-48"}`}>
          <Suspense fallback={<pre className="code-preview">{toolInput.slice(0, 500)}...</pre>}>
            <LazyMarkdown content={toolInput} />
          </Suspense>
        </div>
      );
    }
    const { text: displayText } = truncateContent(toolInput, 6);
    return (
      <pre className="code-preview mb-3 max-h-48">
        {displayText}
      </pre>
    );
  };

  return (
    <Card className="border-border bg-accent/50">
      <div className="flex items-center justify-between gap-2 px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Shield className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium">Permission: {toolName}</span>
        </div>
        <div className="flex items-center gap-2">
          {isPlanReview && (
            <button
              className="rounded-md p-1 text-muted-foreground/50 transition-colors hover:text-muted-foreground"
              onClick={() => setExpanded(!expanded)}
              title={expanded ? "收起" : "展开"}
            >
              {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
          )}
          {status === "allowed" && (
            <Badge className="bg-success/10 text-success">Allowed</Badge>
          )}
          {status === "denied" && (
            <Badge className="bg-destructive/10 text-destructive">Denied</Badge>
          )}
        </div>
      </div>
      <CardContent className="pb-3 pt-0">
        {renderContent()}
        {status === "pending" && (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" className="text-primary border-primary/30 hover:bg-primary/5" onClick={onAllow}>
              <Check className="mr-1 h-3.5 w-3.5" />
              Allow
            </Button>
            <Button size="sm" variant="outline" className="text-destructive border-destructive/30 hover:bg-destructive/5" onClick={onDeny}>
              <X className="mr-1 h-3.5 w-3.5" />
              Deny
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
