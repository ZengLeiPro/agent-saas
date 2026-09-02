import { lazy } from "react";
import { markdownRuntimePromise } from "@/lib/markdownRuntime";

export const CjkMarkdown = lazy(async () => {
  const { Markdown, cjkRemarkPlugins } = await markdownRuntimePromise;

  return {
    default: (props: import("react-markdown").Options) => (
      <Markdown {...props} remarkPlugins={cjkRemarkPlugins} />
    ),
  };
});
