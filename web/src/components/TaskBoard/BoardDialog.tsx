import { useEffect, useRef, useState, type FormEvent } from "react";
import type { TaskBoard, TaskBoardCreateInput, TaskBoardPatchInput } from "@agent/shared";
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
import { Textarea } from "@/components/ui/textarea";

type BoardDraftField = "name" | "description";

interface BoardDialogProps {
  open: boolean;
  active?: boolean;
  board?: TaskBoard;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: TaskBoardCreateInput) => Promise<void>;
  onUpdate: (id: string, input: TaskBoardPatchInput) => Promise<void>;
}

export function BoardDialog({
  open,
  active = true,
  board,
  onOpenChange,
  onCreate,
  onUpdate,
}: BoardDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirtyFieldsRef = useRef<Set<BoardDraftField>>(new Set());
  const boardIdRef = useRef<string | null>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    const opening = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (!open) return;
    const boardId = board?.id ?? null;
    const switchedBoard = boardIdRef.current !== boardId;
    if (opening || switchedBoard) {
      boardIdRef.current = boardId;
      dirtyFieldsRef.current.clear();
      setName(board?.name ?? "");
      setDescription(board?.description ?? "");
      setError(null);
      return;
    }
    if (!board) return;
    if (!dirtyFieldsRef.current.has("name")) setName(board.name);
    if (!dirtyFieldsRef.current.has("description")) setDescription(board.description ?? "");
  }, [board, open]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const normalizedName = name.trim();
    if (!normalizedName) {
      setError("请输入看板名称");
      return;
    }
    if (board && dirtyFieldsRef.current.size === 0) {
      onOpenChange(false);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      if (board) {
        const input: TaskBoardPatchInput = { expectedVersion: board.version };
        if (dirtyFieldsRef.current.has("name")) input.name = normalizedName;
        if (dirtyFieldsRef.current.has("description")) input.description = description.trim();
        await onUpdate(board.id, input);
      } else {
        await onCreate({
          name: normalizedName,
          ...(description.trim() ? { description: description.trim() } : {}),
        });
      }
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存看板失败");
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{board ? "编辑看板" : "创建看板"}</DialogTitle>
          <DialogDescription>
            {board ? "修改看板名称和说明。" : "为不同工作主题创建独立看板。"}
          </DialogDescription>
        </DialogHeader>
        <form id="taskboard-board-form" className="space-y-4" onSubmit={submit}>
          <div className="space-y-2">
            <Label htmlFor="taskboard-board-name">名称</Label>
            <Input
              id="taskboard-board-name"
              value={name}
              onChange={(event) => {
                dirtyFieldsRef.current.add("name");
                setName(event.target.value);
              }}
              placeholder="例如：产品研发"
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="taskboard-board-description">说明</Label>
            <Textarea
              id="taskboard-board-description"
              value={description}
              onChange={(event) => {
                dirtyFieldsRef.current.add("description");
                setDescription(event.target.value);
              }}
              placeholder="这个看板用于管理什么？"
              rows={4}
            />
          </div>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            取消
          </Button>
          <Button type="submit" form="taskboard-board-form" disabled={submitting}>
            {submitting ? "保存中..." : board ? "保存" : "创建看板"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
