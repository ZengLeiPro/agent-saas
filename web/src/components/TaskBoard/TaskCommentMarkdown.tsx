import { Suspense } from "react";
import { CjkMarkdown } from "@/components/CjkMarkdown";

const components: import("react-markdown").Components = {
  a: ({ node: _node, children, ...props }) => (
    <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>
  ),
  table: ({ node: _node, children, ...props }) => (
    <div className="overflow-x-auto">
      <table {...props}>{children}</table>
    </div>
  ),
};

export function TaskCommentMarkdown({ body }: { body: string }) {
  return (
    <div className="prose-chat mt-2 overflow-hidden break-words text-sm text-foreground">
      <Suspense fallback={<div className="whitespace-pre-wrap">{body}</div>}>
        <CjkMarkdown components={components}>{body}</CjkMarkdown>
      </Suspense>
    </div>
  );
}
