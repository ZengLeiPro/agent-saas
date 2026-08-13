import { useEffect, useState, type FormEvent } from "react";
import {
  TASKBOARD_PRIORITIES,
  TASKBOARD_STATUSES,
  type ModelList,
  type TaskBoardPriority,
  type TaskBoardStatus,
  type TaskBoardTaskCreateInput,
} from "@agent/shared";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { useFileUpload } from "@/hooks/useFileUpload";
import { PRIORITY_LABELS, STATUS_LABELS } from "./constants";
import { ModelSelect } from "./ModelSelect";
import { TaskAttachmentField, toTaskBoardAttachments } from "./TaskAttachments";

function createClientRequestId(): string {
  return `task-dialog-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

interface TaskDialogProps {
  open: boolean;
  active?: boolean;
  initialStatus?: TaskBoardStatus;
  modelList?: ModelList | null;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: TaskBoardTaskCreateInput) => Promise<void>;
}

export function TaskDialog({
  open,
  active = true,
  initialStatus = "backlog",
  modelList = null,
  onOpenChange,
  onCreate,
}: TaskDialogProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [branch, setBranch] = useState("");
  const [status, setStatus] = useState<TaskBoardStatus>("backlog");
  const [priority, setPriority] = useState<TaskBoardPriority>("none");
  const [dispatch, setDispatch] = useState(false);
  const [clientRequestId, setClientRequestId] = useState("");
  const [model, setModel] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attachments = useFileUpload("taskboard");

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setDescription("");
    setBranch("");
    setStatus(initialStatus);
    setPriority("none");
    setDispatch(false);
    setClientRequestId(createClientRequestId());
    setModel(null);
    setError(null);
    attachments.clearFiles();
  }, [attachments.clearFiles, initialStatus, open]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const normalizedTitle = title.trim();
    if (attachments.uploading) {
      setError("请等待附件上传完成");
      return;
    }
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
        ...(branch.trim() ? { branch: branch.trim() } : {}),
        ...(attachments.uploadedFiles.length
          ? { attachments: toTaskBoardAttachments(attachments.uploadedFiles) }
          : {}),
        status,
        priority,
        ...(clientRequestId ? { clientRequestId } : {}),
        ...(status === "in_progress" && dispatch ? { dispatch: true } : {}),
        ...(model ? { model } : {}),
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
            <Label htmlFor="taskboard-task-title">
              标题 <span className="text-destructive" aria-hidden="true">*</span>
            </Label>
            <Input
              id="taskboard-task-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="要完成什么？"
              disabled={submitting}
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
              disabled={submitting}
              onPaste={(event) => void attachments.handlePaste(event)}
            />
            <TaskAttachmentField upload={attachments} disabled={submitting} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="taskboard-task-branch">工作分支</Label>
            <Input
              id="taskboard-task-branch"
              value={branch}
              onChange={(event) => setBranch(event.target.value)}
              placeholder="例如 task/TASK-32-optimize-board"
              disabled={submitting}
            />
            <p className="text-xs text-muted-foreground">可先留空，由 Agent 创建或确认分支后回写。</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>状态</Label>
              <Select
                value={status}
                onValueChange={(value) => {
                  const nextStatus = value as TaskBoardStatus;
                  setStatus(nextStatus);
                  if (nextStatus !== "in_progress") setDispatch(false);
                }}
                disabled={submitting}
              >
                <SelectTrigger aria-label="新任务状态"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TASKBOARD_STATUSES.map((value) => (
                    <SelectItem key={value} value={value}>{STATUS_LABELS[value]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {status === "in_progress" ? (
                <div className="flex items-center gap-2 pt-1">
                  <Checkbox
                    id="taskboard-task-dispatch"
                    checked={dispatch}
                    onCheckedChange={(checked) => setDispatch(checked === true)}
                    disabled={submitting}
                  />
                  <Label htmlFor="taskboard-task-dispatch" className="font-normal">直接执行</Label>
                </div>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label>优先级</Label>
              <Select
                value={priority}
                onValueChange={(value) => setPriority(value as TaskBoardPriority)}
                disabled={submitting}
              >
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
            <Label>运行模型</Label>
            <ModelSelect
              modelList={modelList}
              value={model}
              onChange={setModel}
              inheritLabel="继承看板默认模型"
              ariaLabel="任务运行模型"
              disabled={submitting}
            />
          </div>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            取消
          </Button>
          <Button type="submit" form="taskboard-task-form" disabled={submitting || attachments.uploading}>
            {submitting ? "创建中..." : "创建任务"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
