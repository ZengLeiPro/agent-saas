import { useMemo } from "react";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useUsers } from "@/components/UserManager/hooks";
import type { Tenant, UserInfo } from "./types";

interface TenantUsersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenant: Tenant | null;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function TenantUsersDialog({
  open,
  onOpenChange,
  tenant,
}: TenantUsersDialogProps) {
  // 平台 admin 能看到所有用户，按 tenantId 前端筛选即可。
  // 后端 /api/auth/users 平台 admin 返回全量，已自带 tenantId 字段。
  const { users, loading } = useUsers();

  const tenantUsers = useMemo<UserInfo[]>(() => {
    if (!tenant) return [];
    return users.filter((u) => u.tenantId === tenant.id);
  }, [users, tenant]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {tenant?.name} 下的用户
          </DialogTitle>
          <DialogDescription>
            共 {tenantUsers.length} 个用户（slug: <code className="font-mono">{tenant?.id}</code>）
          </DialogDescription>
        </DialogHeader>

        {loading && users.length === 0 ? (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            加载中...
          </div>
        ) : tenantUsers.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            该组织下暂无用户
          </div>
        ) : (
          <div className="max-h-[60vh] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>用户名</TableHead>
                  <TableHead>角色</TableHead>
                  <TableHead className="hidden sm:table-cell">创建时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tenantUsers.map((u) => (
                  <TableRow key={u.id} className={u.disabled ? "opacity-50" : ""}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        {u.avatar ? (
                          <img
                            src={u.avatar}
                            alt=""
                            className="h-6 w-6 shrink-0 rounded-full object-cover"
                          />
                        ) : (
                          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
                            {(u.realName || u.username).charAt(0).toUpperCase()}
                          </div>
                        )}
                        <span>{u.realName || u.username}</span>
                        {u.realName && (
                          <span className="text-xs text-muted-foreground">
                            {u.username}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <Badge
                          variant={u.role === "admin" ? "default" : "secondary"}
                        >
                          {u.role === "admin" ? "管理员" : "用户"}
                        </Badge>
                        {u.disabled && (
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
                      {formatTime(u.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
