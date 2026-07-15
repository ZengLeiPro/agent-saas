import { useMemo, useState } from "react";
import { resolveApiAssetUrl } from "@/lib/apiBase";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  FileText,
  Pencil,
  Trash2,
  UserCheck,
  UserX,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { UserInfo } from "./types";

interface UserTableProps {
  users: UserInfo[];
  currentUserId: string;
  onEdit: (user: UserInfo) => void;
  onDelete: (user: UserInfo) => void;
  onViewLogs: (user: UserInfo) => void;
  onToggleDisabled: (user: UserInfo) => void;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return iso;
  }
}

type SortField = "lastActiveTime" | "createdAt";
type SortDir = "asc" | "desc";

function SortIcon({
  field,
  current,
  dir,
}: {
  field: SortField;
  current: SortField | null;
  dir: SortDir;
}) {
  if (current !== field)
    return <ArrowUpDown className="size-3.5 ml-1 opacity-40" />;
  return dir === "asc" ? (
    <ArrowUp className="size-3.5 ml-1" />
  ) : (
    <ArrowDown className="size-3.5 ml-1" />
  );
}

export function UserTable({
  users,
  currentUserId,
  onEdit,
  onDelete,
  onViewLogs,
  onToggleDisabled,
}: UserTableProps) {
  const [sortField, setSortField] = useState<SortField | null>(
    "lastActiveTime",
  );
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      if (sortDir === "desc") setSortDir("asc");
      else {
        setSortField(null);
        setSortDir("desc");
      } // 第三次点击取消排序
    } else {
      setSortField(field);
      setSortDir("desc");
    }
  };

  // 平台管理员身份必须取自登录态（JWT/me），不能从传入的 users 列表推断：
  // 平台管理员切到其他组织时，列表已按 tenantIdScope 过滤、不含自己，
  // 从列表推断会误判为非平台管理员，导致其他组织 admin 的管理按钮消失。
  const { isPlatformAdmin } = useAuth();

  const canManageUser = (user: UserInfo): boolean => {
    if (isPlatformAdmin) return true;
    return user.id === currentUserId || user.role !== "admin";
  };

  const sorted = useMemo(() => {
    if (!sortField) return users;
    return [...users].sort((a, b) => {
      const av =
        sortField === "lastActiveTime"
          ? (a as any).lastActiveTime || ""
          : a.createdAt;
      const bv =
        sortField === "lastActiveTime"
          ? (b as any).lastActiveTime || ""
          : b.createdAt;
      if (av === bv) return 0;
      const cmp = av < bv ? -1 : 1;
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [users, sortField, sortDir]);

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>用户名</TableHead>
          <TableHead>角色</TableHead>
          <TableHead className="hidden sm:table-cell">移动端最后活跃</TableHead>
          <TableHead className="hidden sm:table-cell">App 版本</TableHead>
          <TableHead className="hidden sm:table-cell">
            <button
              type="button"
              className="inline-flex items-center hover:text-foreground transition-colors"
              onClick={() => toggleSort("lastActiveTime")}
            >
              最后活跃
              <SortIcon
                field="lastActiveTime"
                current={sortField}
                dir={sortDir}
              />
            </button>
          </TableHead>
          <TableHead className="hidden sm:table-cell">
            <button
              type="button"
              className="inline-flex items-center hover:text-foreground transition-colors"
              onClick={() => toggleSort("createdAt")}
            >
              创建时间
              <SortIcon field="createdAt" current={sortField} dir={sortDir} />
            </button>
          </TableHead>
          <TableHead className="text-right">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((user) => (
          <TableRow key={user.id} className={user.disabled ? "opacity-50" : ""}>
            <TableCell className="font-medium">
              <div className="flex items-center gap-1.5">
                {user.avatar ? (
                  <img
                    src={resolveApiAssetUrl(user.avatar)}
                    alt=""
                    className="size-6 shrink-0 rounded-full object-cover"
                  />
                ) : (
                  <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
                    {(user.realName || user.username).charAt(0).toUpperCase()}
                  </div>
                )}
                <span>{user.realName || user.username}</span>
                {user.realName && (
                  <span className="text-xs text-muted-foreground">
                    {user.username}
                  </span>
                )}
                {user.dingtalkStaffId && (
                  <span
                    className="inline-flex shrink-0 items-center rounded px-1 py-0.5 text-[10px] leading-none font-medium bg-accent text-muted-foreground"
                    title={`钉钉 staffId: ${user.dingtalkStaffId}`}
                  >
                    钉钉
                  </span>
                )}
              </div>
            </TableCell>
            <TableCell>
              <div className="flex items-center gap-1.5">
                <Badge
                  variant={user.role === "admin" ? "default" : "secondary"}
                >
                  {user.role === "admin" ? "管理员" : "用户"}
                </Badge>
                {user.disabled && (
                  <Badge
                    variant="outline"
                    className="text-destructive border-destructive/50"
                  >
                    已禁用
                  </Badge>
                )}
              </div>
            </TableCell>
            <TableCell className="hidden sm:table-cell text-muted-foreground text-sm">
              {(user as any).mobileLastActiveTime
                ? formatTime((user as any).mobileLastActiveTime)
                : "-"}
            </TableCell>
            <TableCell className="hidden sm:table-cell text-muted-foreground text-sm">
              {user.appVersion || "-"}
            </TableCell>
            <TableCell className="hidden sm:table-cell text-muted-foreground text-sm">
              {(user as any).lastActiveTime
                ? formatTime((user as any).lastActiveTime)
                : "-"}
            </TableCell>
            <TableCell className="hidden sm:table-cell text-muted-foreground text-sm">
              {formatTime(user.createdAt)}
            </TableCell>
            <TableCell className="text-right">
              <div className="flex items-center justify-end gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  onClick={() => onViewLogs(user)}
                  title="操作日志"
                >
                  <FileText className="size-4" />
                </Button>
                {canManageUser(user) && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    onClick={() => onEdit(user)}
                    title="编辑"
                  >
                    <Pencil className="size-4" />
                  </Button>
                )}
                {canManageUser(user) && user.id !== currentUserId && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className={`size-8 ${user.disabled ? "text-success hover:text-success/80" : "text-muted-foreground hover:text-warning"}`}
                    onClick={() => onToggleDisabled(user)}
                    title={user.disabled ? "启用" : "禁用"}
                  >
                    {user.disabled ? (
                      <UserCheck className="size-4" />
                    ) : (
                      <UserX className="size-4" />
                    )}
                  </Button>
                )}
                {canManageUser(user) && user.id !== currentUserId && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 text-muted-foreground hover:text-destructive"
                    onClick={() => onDelete(user)}
                    title="删除"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                )}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
