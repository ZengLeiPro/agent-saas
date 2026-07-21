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
import {
  PLATFORM_CAPABILITIES,
  type PlatformCapability,
  type PlatformCapabilityLimits,
} from "@agent/shared";
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
  platformCapabilities?: PlatformCapability[];
  platformCapabilityLimits?: PlatformCapabilityLimits;
  tenantId?: string;
}

const CAPABILITY_LABELS: Record<PlatformCapability, { title: string; description: string }> = {
  "tenant.manage": { title: "组织运营", description: "创建组织、修改组织名称" },
  "user.manage": { title: "客户账号", description: "创建、编辑、启停非万神殿账号" },
  "customer_config.manage": { title: "客户配置", description: "维护公司信息、技能、企业专家和组织设置" },
  "billing.adjust": { title: "积分流水", description: "在授权额度内写入充值、赠送或退款流水" },
  "credential.reset": { title: "密码重置", description: "为客户账号重置密码" },
  "runtime.operate": { title: "运行恢复", description: "暂停/恢复执行环境、重扫用量与存储" },
  "finance.read": { title: "内部财务", description: "查看真实成本、毛利、价格版本和用量明细" },
  "workflow_demo.review": { title: "演示复核", description: "独立复核工作流演示运行与证据指纹" },
  "workflow_demo.publish": { title: "演示发布", description: "发布已由另一身份复核通过的只读回放" },
};

interface UserFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = 创建模式；有值 = 编辑模式 */
  editingUser: UserInfo | null;
  onSubmit: (data: UserFormData) => Promise<void>;
  onResetPassword?: (user: UserInfo) => void;
  defaultTenantId?: string;
  lockTenant?: boolean;
}

export function UserFormDialog({
  open,
  onOpenChange,
  editingUser,
  onSubmit,
  onResetPassword,
  defaultTenantId,
  lockTenant = false,
}: UserFormDialogProps) {
  const isEdit = editingUser !== null;
  const { user: currentUser, isPlatformAdmin, isSuperAdmin } = useAuth();
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
  const [platformCapabilities, setPlatformCapabilities] = useState<PlatformCapability[]>([]);
  const [billingPerTransaction, setBillingPerTransaction] = useState("");
  const [billingPerDay, setBillingPerDay] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const isEditingSelf = isEdit && editingUser?.id === currentUser?.id;
  const isEditingPeerAdmin =
    isEdit &&
    editingUser?.role === "admin" &&
    !isEditingSelf &&
    !isPlatformAdmin;
  const canChangeRole = !isEditingSelf && !isEditingPeerAdmin;
  const canChangeTenant = isSuperAdmin && !isEditingSelf;
  const isPlatformAccount = role === "admin" && tenantId === DEFAULT_TENANT_ID;
  const visibleTenants = isSuperAdmin
    ? tenants
    : tenants.filter((tenant) => tenant.id !== DEFAULT_TENANT_ID || tenant.id === tenantId);
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
      setPlatformCapabilities(editingUser?.platformCapabilities ?? []);
      setBillingPerTransaction(
        editingUser?.platformCapabilityLimits?.billingMaxCreditsPerTransaction?.toString() || "",
      );
      setBillingPerDay(
        editingUser?.platformCapabilityLimits?.billingMaxCreditsPerDay?.toString() || "",
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
    if (isSuperAdmin && isPlatformAccount && platformCapabilities.includes("billing.adjust")) {
      const perTransaction = Number(billingPerTransaction);
      const perDay = Number(billingPerDay);
      if (!Number.isFinite(perTransaction) || perTransaction <= 0
        || !Number.isFinite(perDay) || perDay <= 0) {
        setError("授权积分流水时必须填写正数的单笔上限和每日上限");
        return;
      }
      if (perDay < perTransaction) {
        setError("每日上限不能小于单笔上限");
        return;
      }
    }

    setError("");
    setLoading(true);
    try {
      const permissions: UserPermissions = {};
      if (maxTurns) permissions.maxTurns = Number(maxTurns);
      if (maxRequests)
        permissions.rateLimit = { maxRequests: Number(maxRequests) };
      const hasPermissions = Object.keys(permissions).length > 0;
      const capabilityLimits: PlatformCapabilityLimits | undefined =
        isSuperAdmin && isPlatformAccount && platformCapabilities.includes("billing.adjust")
          ? {
              billingMaxCreditsPerTransaction: Number(billingPerTransaction),
              billingMaxCreditsPerDay: Number(billingPerDay),
            }
          : isSuperAdmin && isPlatformAccount
            ? {}
            : undefined;

      await onSubmit({
        username: username.trim(),
        password: isEdit ? "" : password,
        role,
        realName: realName.trim() || undefined,
        position: position.trim() || undefined,
        dingtalkStaffId: dingtalkStaffId.trim() || undefined,
        debugMode,
        permissions: hasPermissions ? permissions : undefined,
        platformCapabilities: isSuperAdmin && isPlatformAccount ? platformCapabilities : undefined,
        platformCapabilityLimits: capabilityLimits,
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
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
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
              autoComplete="off"
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
          {!isEdit && (
            <div className="space-y-2">
              <Label htmlFor="form-new-password">密码</Label>
              <Input
                id="form-new-password"
                name="new-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={loading}
                placeholder="请输入密码（至少 6 位）"
                autoComplete="new-password"
              />
            </div>
          )}

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
                  {visibleTenants.map((tenant) => (
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
                关闭时，该用户只能看到 Agent 输出；思考、工具调用和技能执行细节会显示为等待提示。
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
          <div className="grid gap-3 sm:grid-cols-2">
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
          {isSuperAdmin && isPlatformAccount && (
            <div className="space-y-3 rounded-lg border border-border p-3">
              <div>
                <Label>平台运营能力</Label>
                <p className="mt-1 text-xs text-muted-foreground">
                  未勾选的能力由服务端拒绝；Secret、平台全局配置、原始会话内容和硬删除始终仅 @admin 可执行。
                </p>
              </div>
              <div className="grid gap-2">
                {PLATFORM_CAPABILITIES.map((capability) => {
                  const checked = platformCapabilities.includes(capability);
                  const label = CAPABILITY_LABELS[capability];
                  return (
                    <label key={capability} className="flex items-start gap-2 rounded-md border px-3 py-2">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={checked}
                        onChange={(event) => setPlatformCapabilities((current) => (
                          event.target.checked
                            ? [...current, capability]
                            : current.filter((item) => item !== capability)
                        ))}
                        disabled={loading}
                      />
                      <span>
                        <span className="block text-sm font-medium">{label.title}</span>
                        <span className="block text-xs text-muted-foreground">{label.description}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
              {platformCapabilities.includes("billing.adjust") && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="billing-per-transaction">单笔积分上限</Label>
                    <Input
                      id="billing-per-transaction"
                      type="number"
                      min={1}
                      value={billingPerTransaction}
                      onChange={(event) => setBillingPerTransaction(event.target.value)}
                      disabled={loading}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="billing-per-day">每日积分上限</Label>
                    <Input
                      id="billing-per-day"
                      type="number"
                      min={1}
                      value={billingPerDay}
                      onChange={(event) => setBillingPerDay(event.target.value)}
                      disabled={loading}
                    />
                  </div>
                </div>
              )}
            </div>
          )}
          {error && (
            <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
          <div className="flex items-center justify-between gap-2 pt-2">
            <div>
              {isEdit && editingUser && onResetPassword && (
                <Button
                  variant="outline"
                  onClick={() => onResetPassword(editingUser)}
                  disabled={loading}
                >
                  重置密码
                </Button>
              )}
            </div>
            <div className="flex justify-end gap-2">
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
                    <Loader2 className="size-4 animate-spin" />
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
        </div>
      </DialogContent>
    </Dialog>
  );
}
