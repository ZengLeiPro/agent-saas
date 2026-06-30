import {
  Building2,
  Pencil,
  Power,
  PowerOff,
  Users,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Tenant } from "./types";
import { DEFAULT_TENANT_ID } from "./types";

interface TenantTableProps {
  tenants: Tenant[];
  onEdit: (tenant: Tenant) => void;
  onToggleDisabled: (tenant: Tenant) => void;
  onViewUsers: (tenant: Tenant) => void;
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

export function TenantTable({
  tenants,
  onEdit,
  onToggleDisabled,
  onViewUsers,
}: TenantTableProps) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>组织</TableHead>
          <TableHead>Slug</TableHead>
          <TableHead className="hidden sm:table-cell">状态</TableHead>
          <TableHead className="hidden sm:table-cell">创建时间</TableHead>
          <TableHead className="hidden md:table-cell">更新时间</TableHead>
          <TableHead className="text-right">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {tenants.map((tenant) => {
          const isDefault = tenant.id === DEFAULT_TENANT_ID;
          return (
            <TableRow
              key={tenant.id}
              className={tenant.disabled ? "opacity-50" : ""}
            >
              <TableCell className="font-medium">
                <div className="flex items-center gap-2">
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <Building2 className="h-3.5 w-3.5" />
                  </div>
                  <span>{tenant.name}</span>
                  {isDefault && (
                    <Badge variant="default" className="shrink-0 text-[10px]">
                      默认
                    </Badge>
                  )}
                </div>
              </TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">
                {tenant.id}
              </TableCell>
              <TableCell className="hidden sm:table-cell">
                {tenant.disabled ? (
                  <Badge
                    variant="outline"
                    className="text-destructive border-destructive/50"
                  >
                    已禁用
                  </Badge>
                ) : (
                  <Badge variant="secondary">启用中</Badge>
                )}
              </TableCell>
              <TableCell className="hidden sm:table-cell text-muted-foreground text-sm">
                {formatTime(tenant.createdAt)}
              </TableCell>
              <TableCell className="hidden md:table-cell text-muted-foreground text-sm">
                {formatTime(tenant.updatedAt)}
              </TableCell>
              <TableCell className="text-right">
                <div className="flex items-center justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => onViewUsers(tenant)}
                    title="查看用户"
                  >
                    <Users className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => onEdit(tenant)}
                    title="管理组织"
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  {!isDefault && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className={`h-8 w-8 ${tenant.disabled ? "text-success hover:text-success/80" : "text-muted-foreground hover:text-warning"}`}
                      onClick={() => onToggleDisabled(tenant)}
                      title={tenant.disabled ? "启用" : "禁用"}
                    >
                      {tenant.disabled ? (
                        <Power className="h-4 w-4" />
                      ) : (
                        <PowerOff className="h-4 w-4" />
                      )}
                    </Button>
                  )}
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
