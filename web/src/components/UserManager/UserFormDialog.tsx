import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DEFAULT_TENANT_ID } from "@/components/TenantManager/types";
import { useTenants } from "@/components/TenantManager/hooks";
import { useAuth } from "@/contexts/AuthContext";
import { ROLE_POSITION_OPTIONS } from "@/lib/roleOptions";
import type { UserInfo, UserPermissions } from "./types";

const POSITION_EMPTY_VALUE = "__none__";

export interface UserFormData {
  username: string;
  password: string;
  role: "admin" | "user";
  realName?: string;
  position?: string;
  dingtalkStaffId?: string;
  debugMode?: boolean;
  permissions?: UserPermissions;
  tenantId?: string;
}

interface UserFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = 创建模式；有值 = 编辑模式 */
  editingUser: UserInfo | null;
  onSubmit: (data: UserFormData) => Promise<void>;
  defaultTenantId?: string;
  lockTenant?: boolean;
}

export function UserFormDialog({
  open,
  onOpenChange,
  editingUser,
  onSubmit,
  defaultTenantId,
  lockTenant = false,
}: UserFormDialogProps) {
  const isEdit = editingUser !== null;
  const { user: currentUser, isPlatformAdmin } = useAuth();
  const { tenants } = useTenants();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "user">("user");
  const [realName, setRealName] = useState("");
  const [position, setPosition] = useState("");
  const [dingtalkStaffId, setDingtalkStaffId] = useState("");
  const [debugMode, setDebugMode] = useState(false);
  const [maxTurns, setMaxTurns] = useState("");
  const [maxRequests, setMaxRequests] = useState("");
  const [tenantId, setTenantId] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const isEditingSelf = isEdit && editingUser?.id === currentUser?.id;
  const isEditingPeerAdmin =
    isEdit &&
    editingUser?.role === "admin" &&
    !isEditingSelf &&
    !isPlatformAdmin;
  const canChangeRole = !isEditingSelf && !isEditingPeerAdmin;
  const canChangeTenant = isPlatformAdmin && !isEditingSelf;
  const positionOptions = position && !ROLE_POSITION_OPTIONS.some((item) => item === position)
    ? [position, ...ROLE_POSITION_OPTIONS]
    : ROLE_POSITION_OPTIONS;

  useEffect(() => {
    if (open) {
      setUsername(editingUser?.username || "");
      setPassword("");
      setRole(editingUser?.role || "user");
      setRealName(editingUser?.realName || "");
      setPosition(editingUser?.position || "");
      setDingtalkStaffId(editingUser?.dingtalkStaffId || "");
      setDebugMode(editingUser?.debugMode === true);
      setTenantId(editingUser?.tenantId || defaultTenantId || currentUser?.tenantId || DEFAULT_TENANT_ID);
      setMaxTurns(editingUser?.permissions?.maxTurns?.toString() || "");
      setMaxRequests(
        editingUser?.permissions?.rateLimit?.maxRequests?.toString() || "",
      );
      setError("");
    }
  }, [open, editingUser]);

  const handleSubmit = async () => {
    if (!isEdit && !username.trim()) {
      setError("请输入用户名");
      return;
    }
    if (!isEdit && !password) {
      setError("请输入密码");
      return;
    }
    if (!isEdit && password.length < 6) {
      setError("密码至少 6 位");
      return;
    }
    if (isPlatformAdmin && !tenantId) {
      setError("请选择组织");
      return;
    }
    if (isEditingPeerAdmin) {
      setError("组织管理员不能管理其他管理员");
      return;
    }
    if (isEditingSelf && editingUser?.role === "admin" && role !== "admin") {
      setError("不能降级自己");
      return;
    }
    if (isEditingSelf && tenantId && tenantId !== editingUser?.tenantId) {
      setError("不能修改自己的组织归属");
      return;
    }

    setError("");
    setLoading(true);
    try {
      const permissions: UserPermissions = {};
      if (maxTurns) permissions.maxTurns = Number(maxTurns);
      if (maxRequests)
        permissions.rateLimit = { maxRequests: Number(maxRequests) };
      const hasPermissions = Object.keys(permissions).length > 0;

      await onSubmit({
        username: username.trim(),
        password,
        role,
        realName: realName.trim() || undefined,
        position: position.trim() || undefined,
        dingtalkStaffId: dingtalkStaffId.trim() || undefined,
        debugMode,
        permissions: hasPermissions ? permissions : undefined,
        tenantId: isPlatformAdmin ? tenantId : undefined,
      });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "编辑用户" : "新建用户"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="form-username">用户名</Label>
            <Input
              id="form-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={isEdit || loading}
              placeholder="请输入用户名"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="form-realname">真实姓名</Label>
            <Input
              id="form-realname"
              value={realName}
              onChange={(e) => setRealName(e.target.value)}
              disabled={loading}
              placeholder="可选，用于 AI 识别用户身份"
            />
          </div>
          <div className="space-y-2">
            <Label>岗位</Label>
            <Select
              value={position || POSITION_EMPTY_VALUE}
              onValueChange={(value) => setPosition(value === POSITION_EMPTY_VALUE ? "" : value)}
              disabled={loading}
            >
              <SelectTrigger>
                <SelectValue placeholder="选择岗位，AI 同事按岗位为您准备场景" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={POSITION_EMPTY_VALUE}>暂不设置</SelectItem>
                {positionOptions.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="form-password">
              密码{isEdit ? "（留空不修改）" : ""}
            </Label>
            <Input
              id="form-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
              placeholder={isEdit ? "留空不修改" : "请输入密码（至少 6 位）"}
            />
          </div>

          {isPlatformAdmin && (
            <div className="space-y-2">
              <Label>归属组织</Label>
              <Select
                value={tenantId}
                onValueChange={setTenantId}
                disabled={loading || lockTenant || !canChangeTenant}
              >
                <SelectTrigger>
                  <SelectValue placeholder="请选择组织" />
                </SelectTrigger>
                <SelectContent>
                  {tenants.map((tenant) => (
                    <SelectItem key={tenant.id} value={tenant.id} disabled={tenant.disabled}>
                      {tenant.name}（{tenant.id}{tenant.disabled ? "，已禁用" : ""}）
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{lockTenant ? "当前成员页已锁定到所选组织。" : "仅平台管理员可跨组织创建或迁移用户；组织管理员始终归属自己的组织。"}</p>
            </div>
          )}
          <div className="space-y-2">
            <Label>角色</Label>
            <Select
              value={role}
              onValueChange={(v) => setRole(v as "admin" | "user")}
              disabled={loading || !canChangeRole}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">管理员</SelectItem>
                <SelectItem value="user">用户</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="form-dingtalk">钉钉 staffId</Label>
            <Input
              id="form-dingtalk"
              value={dingtalkStaffId}
              onChange={(e) => setDingtalkStaffId(e.target.value)}
              disabled={loading}
              placeholder="可选，用于关联钉钉身份"
            />
          </div>
          <div className="flex items-start justify-between gap-4 rounded-lg border border-border px-3 py-2.5">
            <div className="space-y-1">
              <Label htmlFor="form-debug-mode">调试模式</Label>
              <p className="text-xs leading-relaxed text-muted-foreground">
                关闭时，该用户只能看到 Agent 输出；思考、工具调用和 Skill 执行细节会显示为等待提示。
              </p>
            </div>
            <Switch
              id="form-debug-mode"
              checked={debugMode}
              onCheckedChange={setDebugMode}
              disabled={loading}
              aria-label="调试模式"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="form-maxturns">最大轮次</Label>
              <Input
                id="form-maxturns"
                type="number"
                min={1}
                value={maxTurns}
                onChange={(e) => setMaxTurns(e.target.value)}
                disabled={loading}
                placeholder="不限"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="form-maxreqs">每分钟请求数</Label>
              <Input
                id="form-maxreqs"
                type="number"
                min={1}
                value={maxRequests}
                onChange={(e) => setMaxRequests(e.target.value)}
                disabled={loading}
                placeholder="不限"
              />
            </div>
          </div>
          {error && (
            <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={loading}
            >
              取消
            </Button>
            <Button onClick={handleSubmit} disabled={loading}>
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  提交中...
                </>
              ) : isEdit ? (
                "保存"
              ) : (
                "创建"
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
