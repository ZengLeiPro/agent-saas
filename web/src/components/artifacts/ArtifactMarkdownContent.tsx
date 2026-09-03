import { lazy, Suspense } from 'react';

import 'katex/dist/katex.min.css';

import { loadMarkdownRuntime } from '@/lib/markdownRuntime';

const SafeMarkdown = lazy(async () => {
  const { Markdown, remarkPlugins, rehypePlugins } = await loadMarkdownRuntime();
  return {
    default: ({ content }: { content: string }) => (
      <Markdown
        skipHtml
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={{
          a: ({ children, href }) =>
            isSafeLink(href) ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          img: ({ alt }) => (
            <span className="text-muted-foreground">[图片已阻止：{alt || '无描述'}]</span>
          ),
          table: ({ children, ...props }) => (
            <div className="max-w-full overflow-x-auto">
              <table {...props}>{children}</table>
            </div>
          ),
        }}
      >
        {content}
      </Markdown>
    ),
  };
});

export function ArtifactMarkdownContent({ content }: { content: string }) {
  return (
    <Suspense
      fallback={<div className="p-5 text-sm text-muted-foreground">正在解析 Markdown…</div>}
    >
      <div className="prose prose-chat max-w-none break-words text-sm">
        <SafeMarkdown content={content} />
      </div>
    </Suspense>
  );
}

function isSafeLink(href?: string): boolean {
  if (!href) return false;
  return href.startsWith('#') || /^https?:\/\//i.test(href);
}
