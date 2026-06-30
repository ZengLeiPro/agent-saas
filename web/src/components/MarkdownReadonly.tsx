import { lazy, Suspense } from "react";
import { extractTextFromChildren, getCellMinWidthPx } from "@/lib/tableCellWidth";

const markdownPromise = import("react-markdown");

const LazyMarkdown = lazy(async () => {
  const [{ default: Markdown }, { default: remarkGfm }, { default: remarkMath }, { default: rehypeKatex }] = await Promise.all([
    markdownPromise,
    import("remark-gfm"),
    import("remark-math"),
    import("rehype-katex"),
  ]);

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
      <Markdown remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: false }]]} rehypePlugins={[rehypeKatex]} components={mdComponents}>
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
