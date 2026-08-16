import { useCallback, useEffect, useState } from "react";
import type { TaskBoard } from "@agent/shared";
import type { TaskBoardMember, TaskBoardMemberRole } from "@agent/shared/types/taskboard";
import { LoaderCircle, Trash2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import * as api from "./api";
import { MEMBER_ROLE_LABELS } from "./constants";

type EditableRole = Exclude<TaskBoardMemberRole, "owner">;
const EDITABLE_ROLES: EditableRole[] = ["viewer", "editor", "maintainer"];

interface BoardMembersProps {
  board: TaskBoard;
  canManage: boolean;
}

export function BoardMembers({ board, canManage }: BoardMembersProps) {
  const [members, setMembers] = useState<TaskBoardMember[]>([]);
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<EditableRole>("viewer");
  const [loading, setLoading] = useState(true);
  const [savingUserId, setSavingUserId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setMembers(await api.fetchBoardMembers(board.id));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "加载看板成员失败");
    } finally {
      setLoading(false);
    }
  }, [board.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveMember = async (targetUserId: string, nextRole: EditableRole) => {
    setSavingUserId(targetUserId);
    setError(null);
    try {
      const next = await api.upsertBoardMember(board.id, { userId: targetUserId, role: nextRole });
      setMembers((current) => current.some((member) => member.userId === next.userId)
        ? current.map((member) => member.userId === next.userId ? next : member)
        : [...current, next]);
      setUserId("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存看板成员失败");
    } finally {
      setSavingUserId(null);
    }
  };

  const removeMember = async (member: TaskBoardMember) => {
    setSavingUserId(member.userId);
    setError(null);
    try {
      await api.deleteBoardMember(board.id, member.userId);
      setMembers((current) => current.filter((item) => item.userId !== member.userId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "移除看板成员失败");
    } finally {
      setSavingUserId(null);
    }
  };

  return (
    <section aria-label="看板成员" className="space-y-3 rounded-lg border p-3">
      <div>
        <h3 className="text-sm font-semibold">成员与角色</h3>
        <p className="mt-1 text-xs text-muted-foreground">查看者只读；编辑者维护内容；维护者可推进状态和创建集成批次。</p>
      </div>
      <div className="flex items-center gap-2 rounded-md bg-muted/40 px-3 py-2 text-sm">
        <span className="min-w-0 flex-1 truncate" title={board.ownerUserId}>{board.ownerUserId}</span>
        <span className="text-xs text-muted-foreground">{MEMBER_ROLE_LABELS.owner}</span>
      </div>
      {loading ? (
        <p className="inline-flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在加载成员...</p>
      ) : members.length ? members.map((member) => (
        <div key={member.userId} className="flex items-center gap-2 rounded-md border px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-sm" title={member.userId}>{member.userId}</span>
          <Select
            value={member.role}
            onValueChange={(value) => void saveMember(member.userId, value as EditableRole)}
            disabled={!canManage || savingUserId === member.userId}
          >
            <SelectTrigger className="w-28" aria-label={`${member.userId} 的角色`}><SelectValue /></SelectTrigger>
            <SelectContent>
              {EDITABLE_ROLES.map((value) => <SelectItem key={value} value={value}>{MEMBER_ROLE_LABELS[value]}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label={`移除成员 ${member.userId}`}
            disabled={!canManage || savingUserId === member.userId}
            onClick={() => void removeMember(member)}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      )) : <p className="text-sm text-muted-foreground">暂无单独授权的成员。</p>}
      {canManage ? (
        <div className="grid gap-2 sm:grid-cols-[1fr_7rem_auto] sm:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="taskboard-member-user-id">用户 ID</Label>
            <Input id="taskboard-member-user-id" value={userId} onChange={(event) => setUserId(event.target.value)} placeholder="输入组织成员用户 ID" />
          </div>
          <div className="space-y-1.5">
            <Label>角色</Label>
            <Select value={role} onValueChange={(value) => setRole(value as EditableRole)}>
              <SelectTrigger aria-label="新成员角色"><SelectValue /></SelectTrigger>
              <SelectContent>
                {EDITABLE_ROLES.map((value) => <SelectItem key={value} value={value}>{MEMBER_ROLE_LABELS[value]}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <Button type="button" disabled={!userId.trim() || savingUserId !== null} onClick={() => void saveMember(userId.trim(), role)}>
            <UserPlus className="size-4" />添加
          </Button>
        </div>
      ) : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </section>
  );
}
