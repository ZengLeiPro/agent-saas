import { lazy, Suspense } from "react";
import { loadMarkdownRuntime } from "@/lib/markdownRuntime";
import { extractTextFromChildren, getCellMinWidthPx } from "@/lib/tableCellWidth";

const LazyMarkdown = lazy(async () => {
  const { Markdown, remarkPlugins, rehypePlugins } = await loadMarkdownRuntime();

  const mdComponents: import("react-markdown").Components = {
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
      <Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={mdComponents}>
        {content || "_暂无内容_"}
      </Markdown>
    ),
  };
});

export function MarkdownReadonly({ content }: { content: string }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-md border bg-card px-4 py-3 text-sm shadow-sm">
      <div className="prose prose-sm max-w-none dark:prose-invert">
        <Suspense fallback={<div className="text-muted-foreground">正在渲染预览...</div>}>
          <LazyMarkdown content={content} />
        </Suspense>
      </div>
    </div>
  );
}
