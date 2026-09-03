import { lazy } from "react";
import { loadMarkdownRuntime } from "@/lib/markdownRuntime";

export const CjkMarkdown = lazy(async () => {
  const { Markdown, cjkRemarkPlugins } = await loadMarkdownRuntime();

  return {
    default: (props: import("react-markdown").Options) => (
      <Markdown {...props} remarkPlugins={cjkRemarkPlugins} />
    ),
  };
});
