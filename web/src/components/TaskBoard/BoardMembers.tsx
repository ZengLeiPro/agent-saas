import { useCallback, useEffect, useMemo, useState } from "react";
import type { TaskBoard } from "@agent/shared";
import type { TaskBoardDirectoryUser, TaskBoardMember, TaskBoardMemberRole } from "@agent/shared/types/taskboard";
import { Check, LoaderCircle, Search, Trash2, UserPlus } from "lucide-react";
import { UserAvatar } from "@/components/AgentAvatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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

function userLabel(user: TaskBoardDirectoryUser | undefined, fallbackId?: string): string {
  if (!user) return fallbackId || "未知用户";
  const username = user.username.trim() || user.id;
  const realName = user.realName?.trim();
  return realName ? `${realName} @${username}` : username;
}

function userSearchText(user: TaskBoardDirectoryUser): string {
  return [user.id, user.username, user.realName].filter(Boolean).join(" ").toLocaleLowerCase("zh-CN");
}

export function BoardMembers({ board, canManage }: BoardMembersProps) {
  const [members, setMembers] = useState<TaskBoardMember[]>([]);
  const [users, setUsers] = useState<TaskBoardDirectoryUser[]>([]);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [userSearch, setUserSearch] = useState("");
  const [userPickerOpen, setUserPickerOpen] = useState(false);
  const [role, setRole] = useState<EditableRole>("viewer");
  const [loading, setLoading] = useState(true);
  const [savingUserId, setSavingUserId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [nextMembers, nextUsers] = await Promise.all([
        api.fetchBoardMembers(board.id),
        api.fetchTaskboardUsers(),
      ]);
      setMembers(nextMembers);
      setUsers(nextUsers);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "加载看板成员或组织用户失败");
    } finally {
      setLoading(false);
    }
  }, [board.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const usersById = useMemo(
    () => new Map(users.map((user) => [user.id, user])),
    [users],
  );
  const selectedUser = selectedUserId ? usersById.get(selectedUserId) : undefined;
  const availableUsers = useMemo(() => {
    const memberIds = new Set([board.ownerUserId, ...members.map((member) => member.userId)]);
    const keyword = userSearch.trim().toLocaleLowerCase("zh-CN");
    return users.filter((user) => {
      if (memberIds.has(user.id)) return false;
      return !keyword || userSearchText(user).includes(keyword);
    });
  }, [board.ownerUserId, members, userSearch, users]);

  const saveMember = async (targetUserId: string, nextRole: EditableRole) => {
    setSavingUserId(targetUserId);
    setError(null);
    try {
      const next = await api.upsertBoardMember(board.id, { userId: targetUserId, role: nextRole });
      setMembers((current) => current.some((member) => member.userId === next.userId)
        ? current.map((member) => member.userId === next.userId ? next : member)
        : [...current, next]);
      setSelectedUserId("");
      setUserSearch("");
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
        <UserAvatar
          userId={board.ownerUserId}
          avatar={usersById.get(board.ownerUserId)?.avatar}
          version={usersById.get(board.ownerUserId)?.avatarVersion}
          size={24}
        />
        <span className="min-w-0 flex-1 truncate" title={userLabel(usersById.get(board.ownerUserId), board.ownerUserId)}>
          {userLabel(usersById.get(board.ownerUserId), board.ownerUserId)}
        </span>
        <span className="text-xs text-muted-foreground">{MEMBER_ROLE_LABELS.owner}</span>
      </div>
      {loading ? (
        <p className="inline-flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在加载成员与组织用户...</p>
      ) : members.length ? members.map((member) => {
        const user = usersById.get(member.userId);
        const label = userLabel(user, member.userId);
        return (
          <div key={member.userId} className="flex items-center gap-2 rounded-md border px-3 py-2">
            <UserAvatar userId={member.userId} avatar={user?.avatar} version={user?.avatarVersion} size={24} />
            <span className="min-w-0 flex-1 truncate text-sm" title={label}>{label}</span>
            <Select
              value={member.role}
              onValueChange={(value) => void saveMember(member.userId, value as EditableRole)}
              disabled={!canManage || savingUserId === member.userId}
            >
              <SelectTrigger className="w-28" aria-label={`${label} 的角色`}><SelectValue /></SelectTrigger>
              <SelectContent>
                {EDITABLE_ROLES.map((value) => <SelectItem key={value} value={value}>{MEMBER_ROLE_LABELS[value]}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={`移除成员 ${label}`}
              disabled={!canManage || savingUserId === member.userId}
              onClick={() => void removeMember(member)}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        );
      }) : <p className="text-sm text-muted-foreground">暂无单独授权的成员。</p>}
      {canManage ? (
        <div className="grid gap-2 sm:grid-cols-[1fr_7rem_auto] sm:items-end">
          <div className="space-y-1.5">
            <Label>组织用户</Label>
            <Popover open={userPickerOpen} onOpenChange={setUserPickerOpen}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  role="combobox"
                  aria-expanded={userPickerOpen}
                  aria-label="选择组织用户"
                  disabled={loading || users.length === 0 || savingUserId !== null}
                  className="w-full justify-between font-normal"
                >
                  <span className="truncate">{selectedUser ? userLabel(selectedUser) : "选择组织用户"}</span>
                  <Search className="ml-2 size-4 shrink-0 text-muted-foreground" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-[min(24rem,calc(100vw-2rem))] p-2">
                <Input
                  autoFocus
                  type="search"
                  value={userSearch}
                  onChange={(event) => setUserSearch(event.target.value)}
                  placeholder="搜索姓名、账号或用户 ID"
                  aria-label="搜索组织用户"
                />
                <div role="listbox" aria-label="组织用户列表" className="mt-2 max-h-56 space-y-1 overflow-y-auto">
                  {availableUsers.map((user) => {
                    const label = userLabel(user);
                    return (
                      <button
                        key={user.id}
                        type="button"
                        role="option"
                        aria-selected={selectedUserId === user.id}
                        disabled={user.disabled}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                        onClick={() => {
                          setSelectedUserId(user.id);
                          setUserSearch("");
                          setUserPickerOpen(false);
                        }}
                      >
                        <UserAvatar userId={user.id} avatar={user.avatar} version={user.avatarVersion} size={24} />
                        <span className="min-w-0 flex-1 truncate">{label}</span>
                        {user.disabled ? <span className="text-xs text-muted-foreground">已停用</span> : null}
                        {selectedUserId === user.id ? <Check className="size-4 shrink-0" /> : null}
                      </button>
                    );
                  })}
                  {availableUsers.length === 0 ? (
                    <p className="px-2 py-4 text-center text-xs text-muted-foreground">没有匹配的组织用户</p>
                  ) : null}
                </div>
              </PopoverContent>
            </Popover>
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
          <Button type="button" disabled={!selectedUserId || savingUserId !== null} onClick={() => void saveMember(selectedUserId, role)}>
            <UserPlus className="size-4" />添加
          </Button>
        </div>
      ) : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </section>
  );
}
