import { useEffect, useState, type FormEvent } from "react";
import {
  TASKBOARD_PRIORITIES,
  TASKBOARD_STATUSES,
  type TaskBoardPriority,
  type TaskBoardStatus,
  type TaskBoardTaskCreateInput,
} from "@agent/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { dueAtFromDate, PRIORITY_LABELS, splitLabels, STATUS_LABELS } from "./constants";

interface TaskDialogProps {
  open: boolean;
  active?: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: TaskBoardTaskCreateInput) => Promise<void>;
}

export function TaskDialog({ open, active = true, onOpenChange, onCreate }: TaskDialogProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<TaskBoardStatus>("backlog");
  const [priority, setPriority] = useState<TaskBoardPriority>("none");
  const [labels, setLabels] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setDescription("");
    setStatus("backlog");
    setPriority("none");
    setLabels("");
    setDueDate("");
    setError(null);
  }, [open]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const normalizedTitle = title.trim();
    if (!normalizedTitle) {
      setError("请输入任务标题");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onCreate({
        title: normalizedTitle,
        description: description.trim(),
        status,
        priority,
        labels: splitLabels(labels),
        ...(dueAtFromDate(dueDate) ? { dueAt: dueAtFromDate(dueDate) } : {}),
      });
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "创建任务失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={active && open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && submitting) return;
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>新建任务</DialogTitle>
          <DialogDescription>任务创建后会追加到所选状态列末尾。</DialogDescription>
        </DialogHeader>
        <form id="taskboard-task-form" className="space-y-4" onSubmit={submit}>
          <div className="space-y-2">
            <Label htmlFor="taskboard-task-title">标题</Label>
            <Input
              id="taskboard-task-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="要完成什么？"
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="taskboard-task-description">正文</Label>
            <Textarea
              id="taskboard-task-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="补充上下文和验收信息"
              rows={5}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>状态</Label>
              <Select value={status} onValueChange={(value) => setStatus(value as TaskBoardStatus)}>
                <SelectTrigger aria-label="新任务状态"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TASKBOARD_STATUSES.map((value) => (
                    <SelectItem key={value} value={value}>{STATUS_LABELS[value]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>优先级</Label>
              <Select value={priority} onValueChange={(value) => setPriority(value as TaskBoardPriority)}>
                <SelectTrigger aria-label="新任务优先级"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TASKBOARD_PRIORITIES.map((value) => (
                    <SelectItem key={value} value={value}>{PRIORITY_LABELS[value]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="taskboard-task-labels">标签</Label>
            <Input
              id="taskboard-task-labels"
              value={labels}
              onChange={(event) => setLabels(event.target.value)}
              placeholder="多个标签用逗号分隔"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="taskboard-task-due">截止日期</Label>
            <Input
              id="taskboard-task-due"
              type="date"
              value={dueDate}
              onChange={(event) => setDueDate(event.target.value)}
            />
          </div>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            取消
          </Button>
          <Button type="submit" form="taskboard-task-form" disabled={submitting}>
            {submitting ? "创建中..." : "创建任务"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
