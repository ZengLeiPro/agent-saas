import { lazy, Suspense } from "react";

import type { ChatSessionIndexItem } from "@/types/sidebar";

const SessionShareDialog = lazy(() => import("./SessionShareDialog")
  .then((module) => ({ default: module.SessionShareDialog })));

export function LazySessionShareDialog(props: {
  open: boolean;
  session: ChatSessionIndexItem | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Suspense fallback={null}>
      <SessionShareDialog {...props} />
    </Suspense>
  );
}
