import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type WorkOrderAction = 'amend' | 'pause' | 'resume' | 'review' | 'reassign';

interface WorkOrderControlTarget {
  workOrderId: string;
  shortId: string;
  state: string;
  control: { workerType: 'general' | 'explore' };
}

export function WorkOrderControls({
  workOrder,
  disabled,
  onAction,
}: {
  workOrder: WorkOrderControlTarget;
  disabled: boolean;
  onAction(
    action: WorkOrderAction,
    extra?: { text?: string; workerType?: 'general' | 'explore' },
  ): void;
}) {
  const [amendment, setAmendment] = useState('');
  const [review, setReview] = useState('');
  const [workerType, setWorkerType] = useState<'general' | 'explore'>(workOrder.control.workerType);
  const active = ['queued', 'running', 'waiting_input'].includes(workOrder.state);
  useEffect(() => setWorkerType(workOrder.control.workerType), [workOrder.control.workerType]);

  return (
    <details className="mt-3 rounded-md bg-muted/30 p-2 text-sm">
      <summary className="cursor-pointer font-medium">任务控制 · {workOrder.shortId}</summary>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`amend-${workOrder.workOrderId}`}>补充或变更要求</Label>
          <div className="flex gap-2">
            <Input
              id={`amend-${workOrder.workOrderId}`}
              value={amendment}
              onChange={(event) => setAmendment(event.target.value)}
              placeholder="补充任务要求"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || !amendment.trim()}
              onClick={() => onAction('amend', { text: amendment.trim() })}
            >
              补充任务
            </Button>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`review-${workOrder.workOrderId}`}>复核意见</Label>
          <div className="flex gap-2">
            <Input
              id={`review-${workOrder.workOrderId}`}
              value={review}
              onChange={(event) => setReview(event.target.value)}
              placeholder="要求复核或调整结果"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || !review.trim()}
              onClick={() => onAction('review', { text: review.trim() })}
            >
              发起复核
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-40">
            <Label>执行 Worker</Label>
            <Select
              value={workerType}
              onValueChange={(value) => setWorkerType(value as 'general' | 'explore')}
            >
              <SelectTrigger aria-label="执行 Worker">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="general">通用 Worker</SelectItem>
                <SelectItem value="explore">探索 Worker</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => onAction('reassign', { workerType })}
          >
            改派 Worker
          </Button>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          {active ? (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => onAction('pause')}
            >
              暂停任务
            </Button>
          ) : null}
          {workOrder.state === 'paused' ? (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => onAction('resume')}
            >
              恢复任务
            </Button>
          ) : null}
        </div>
      </div>
    </details>
  );
}
