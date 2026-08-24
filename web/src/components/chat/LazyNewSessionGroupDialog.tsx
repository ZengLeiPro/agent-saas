import { lazy, Suspense } from "react";

import type { SessionGroup } from "@/types/sessionGroup";

const NewSessionGroupDialog = lazy(() => import("./NewSessionGroupDialog")
  .then((module) => ({ default: module.NewSessionGroupDialog })));

export function LazyNewSessionGroupDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: SessionGroup[];
  onSelect: (groupId: string | null) => void;
}) {
  return (
    <Suspense fallback={null}>
      <NewSessionGroupDialog {...props} />
    </Suspense>
  );
}
