import { useState } from "react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { FileText, Loader2, Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuth } from "@/contexts/AuthContext";
import { refreshAll } from "@/lib/refreshBus";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";
import { useUsers } from "./hooks";
import { UserTable } from "./UserTable";
import { UserFormDialog } from "./UserFormDialog";
import { DeleteUserDialog } from "./DeleteUserDialog";
import { LoginLogDialog } from "./LoginLogDialog";
import { ResetUserPasswordDialog } from "./ResetUserPasswordDialog";
import type { UserInfo } from "./types";
import type { UserFormData } from "./UserFormDialog";

export interface UserManagerProps {
  tenantIdScope?: string;
  tenantName?: string;
}

export function UserManager({ tenantIdScope, tenantName }: UserManagerProps = {}) {
  const { user: currentUser } = useAuth();
  const {
    users,
    loading,
    error,
    createUser,
    updateUser,
    deleteUser,
    toggleUserDisabled,
  } = useUsers();
  const [showForm, setShowForm] = useState(false);
  const [editingUser, setEditingUser] = useState<UserInfo | null>(null);
  const [resettingPasswordUser, setResettingPasswordUser] =
    useState<UserInfo | null>(null);
  const [deletingUser, setDeletingUser] = useState<UserInfo | null>(null);
  const [disableTarget, setDisableTarget] = useState<UserInfo | null>(null);
  const [disableError, setDisableError] = useState<string | null>(null);
  const [showLoginLogs, setShowLoginLogs] = useState(false);
  const [logFilterUsername, setLogFilterUsername] = useState<
    string | undefined
  >();

  const isMobile = useIsMobile();
  const visibleUsers = tenantIdScope ? users.filter((u) => u.tenantId === tenantIdScope) : users;

  const openCreate = () => {
    setEditingUser(null);
    setShowForm(true);
  };

  const openEdit = (user: UserInfo) => {
    setEditingUser(user);
    setShowForm(true);
  };

  const openUserLogs = (user: UserInfo) => {
    setLogFilterUsername(user.username);
    setShowLoginLogs(true);
  };

  const handleSubmit = async (data: UserFormData) => {
    if (editingUser) {
      await updateUser(editingUser.id, {
        role: data.role,
        realName: data.realName,
        position: data.position,
        dingtalkStaffId: data.dingtalkStaffId,
        debugMode: data.debugMode,
        permissions: data.permissions,
        tenantId: data.tenantId,
      });
    } else {
      await createUser({ ...data, tenantId: data.tenantId || tenantIdScope });
    }
  };

  const openResetPassword = (user: UserInfo) => {
    setShowForm(false);
    setResettingPasswordUser(user);
  };

  const handleResetPassword = async (id: string, password: string) => {
    await updateUser(id, { password });
  };

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col">
      <SettingsPanelHeader
        title={tenantName ? `${tenantName} · 成员管理` : "用户管理"}
        description={tenantIdScope ? `管理组织 ${tenantIdScope} 下的用户账号与权限。` : "管理组织下的用户账号与权限。"}
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setLogFilterUsername(undefined);
                setShowLoginLogs(true);
              }}
            >
              <FileText className="size-4" />
              操作日志
            </Button>
            {!isMobile && (
              <Button
                variant="outline"
                size="sm"
                onClick={refreshAll}
                disabled={loading}
              >
                <RefreshCw className="size-4" />
                刷新
              </Button>
            )}
            <Button size="sm" onClick={openCreate}>
              <Plus className="size-4" />
              新建用户
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-auto">
      {error && (
        <div className="mb-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            共 {visibleUsers.length} 个用户
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {loading && visibleUsers.length === 0 ? (
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />
              加载中...
            </div>
          ) : (
            <UserTable
              users={visibleUsers}
              currentUserId={currentUser?.id || ""}
              onEdit={openEdit}
              onDelete={setDeletingUser}
              onViewLogs={openUserLogs}
              onToggleDisabled={(user) => {
                if (user.disabled) {
                  // 启用：直接执行
                  toggleUserDisabled(user.id, false).catch((err) => {
                    setDisableError(
                      err instanceof Error ? err.message : String(err),
                    );
                  });
                } else {
                  // 禁用：弹确认框
                  setDisableTarget(user);
                  setDisableError(null);
                }
              }}
            />
          )}
        </CardContent>
      </Card>
      </div>

      <UserFormDialog
        open={showForm}
        onOpenChange={setShowForm}
        editingUser={editingUser}
        onSubmit={handleSubmit}
        onResetPassword={openResetPassword}
        defaultTenantId={tenantIdScope}
        lockTenant={Boolean(tenantIdScope)}
      />

      <ResetUserPasswordDialog
        open={resettingPasswordUser !== null}
        onOpenChange={(open) => {
          if (!open) setResettingPasswordUser(null);
        }}
        user={resettingPasswordUser}
        onConfirm={handleResetPassword}
      />

      <DeleteUserDialog
        open={deletingUser !== null}
        onOpenChange={(open) => {
          if (!open) setDeletingUser(null);
        }}
        user={deletingUser}
        onConfirm={deleteUser}
      />

      <LoginLogDialog
        open={showLoginLogs}
        onOpenChange={setShowLoginLogs}
        filterUsername={logFilterUsername}
      />

      <Dialog
        open={disableTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDisableTarget(null);
            setDisableError(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>禁用用户</DialogTitle>
            <DialogDescription>
              禁用后，
              <strong>
                {disableTarget?.realName || disableTarget?.username}
              </strong>{" "}
              将无法登录和使用所有功能。已有连接将立即断开。
            </DialogDescription>
          </DialogHeader>
          {disableError && (
            <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {disableError}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="outline"
              onClick={() => {
                setDisableTarget(null);
                setDisableError(null);
              }}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                if (!disableTarget) return;
                try {
                  await toggleUserDisabled(disableTarget.id, true);
                  setDisableTarget(null);
                  setDisableError(null);
                } catch (err) {
                  setDisableError(
                    err instanceof Error ? err.message : String(err),
                  );
                }
              }}
            >
              禁用
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
