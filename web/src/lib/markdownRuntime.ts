function createMarkdownRuntime() {
  return Promise.all([
    import("react-markdown"),
    import("remark-gfm"),
    import("remark-cjk-friendly/parseOnly"),
    import("remark-cjk-friendly-gfm-strikethrough/parseOnly"),
    import("remark-math"),
    import("rehype-katex"),
  ]).then(([markdown, remarkGfm, remarkCjkFriendly, remarkCjkFriendlyStrikethrough, remarkMath, rehypeKatex]) => {
    const cjkRemarkPlugins: NonNullable<import("react-markdown").Options["remarkPlugins"]> = [
      remarkGfm.default,
      remarkCjkFriendly.default,
      remarkCjkFriendlyStrikethrough.default,
    ];
    const remarkPlugins: NonNullable<import("react-markdown").Options["remarkPlugins"]> = [
      ...cjkRemarkPlugins,
      [remarkMath.default, { singleDollarTextMath: false }],
    ];
    const rehypePlugins: NonNullable<import("react-markdown").Options["rehypePlugins"]> = [rehypeKatex.default];

    return {
      Markdown: markdown.default,
      cjkRemarkPlugins,
      remarkPlugins,
      rehypePlugins,
    };
  });
}

let runtimePromise: ReturnType<typeof createMarkdownRuntime> | undefined;

export function loadMarkdownRuntime() {
  runtimePromise ??= createMarkdownRuntime();
  return runtimePromise;
}
