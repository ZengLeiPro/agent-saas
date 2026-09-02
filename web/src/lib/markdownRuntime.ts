const markdownPromise = import("react-markdown");
const remarkGfmPromise = import("remark-gfm");
const remarkCjkFriendlyPromise = import("remark-cjk-friendly/parseOnly");
const remarkCjkFriendlyStrikethroughPromise = import("remark-cjk-friendly-gfm-strikethrough/parseOnly");
const remarkMathPromise = import("remark-math");
const rehypeKatexPromise = import("rehype-katex");

export const markdownRuntimePromise = Promise.all([
  markdownPromise,
  remarkGfmPromise,
  remarkCjkFriendlyPromise,
  remarkCjkFriendlyStrikethroughPromise,
  remarkMathPromise,
  rehypeKatexPromise,
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
