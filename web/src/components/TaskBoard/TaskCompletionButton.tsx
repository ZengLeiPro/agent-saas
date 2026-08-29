import type { TaskBoardTask } from "@agent/shared";
import { CircleCheckBig } from "lucide-react";

import { Button } from "@/components/ui/button";

export function canManuallyCompleteTask(
  task: TaskBoardTask | null,
  readOnly: boolean,
  canTransitionTask: boolean,
  executionActive: boolean,
  executionStateReady: boolean,
): boolean {
  if (!task || readOnly || !canTransitionTask || executionActive || !executionStateReady) return false;
  if (task.kind === "integration" || task.kind === "remediation") return false;
  if (task.kind === "delivery" && (
    task.mergeEligibility === "eligible" || task.mergeEligibility === "claimed"
    || Boolean(task.providerPullRequestId && !task.mergedCommitOid)
  )) return false;
  return !["done", "canceled"].includes(task.status);
}

export function TaskCompletionButton({
  visible,
  saving,
  onComplete,
}: {
  visible: boolean;
  saving: boolean;
  onComplete: () => void;
}) {
  if (!visible) return null;
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      aria-label="完成任务"
      onClick={onComplete}
      disabled={saving}
      className="w-[4.5rem] text-emerald-700 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-400"
    >
      <CircleCheckBig />完成
    </Button>
  );
}
