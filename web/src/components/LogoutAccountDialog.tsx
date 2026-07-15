import { Check, LogOut } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { getAccountKey } from "@/lib/savedAccounts";
import { resolveApiAssetUrl } from "@/lib/apiBase";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface LogoutAccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function LogoutAccountDialog({ open, onOpenChange }: LogoutAccountDialogProps) {
  const { user, accounts, logoutCurrentAccount, logoutAllAccounts } = useAuth();
  const currentKey = user ? getAccountKey(user) : null;
  const otherAccounts = accounts.filter((account) => account.key !== currentKey);

  const closeThen = (action: () => void) => {
    onOpenChange(false);
    action();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>退出当前账号</DialogTitle>
          <DialogDescription>
            {otherAccounts.length > 0
              ? `“${user?.realName || user?.username || "当前账号"}”将从此设备退出。请选择接下来使用的账号，或退出全部账号。`
              : `“${user?.realName || user?.username || "当前账号"}”将从此设备退出。`}
          </DialogDescription>
        </DialogHeader>

        {otherAccounts.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground">退出后切换到</div>
            <div className="rounded-xl border p-1">
              {otherAccounts.map((account) => (
                <button
                  key={account.key}
                  type="button"
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-muted"
                  onClick={() => closeThen(() => logoutCurrentAccount(account.key))}
                >
                  {account.user.avatar ? (
                    <img src={resolveApiAssetUrl(account.user.avatar)} alt="" className="size-9 shrink-0 rounded-full object-cover" />
                  ) : (
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-brand-700 text-xs font-semibold text-white">
                      {account.user.username.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{account.user.realName || account.user.username}</span>
                    <span className="block truncate text-xs text-muted-foreground">@{account.user.username}</span>
                  </span>
                  <Check className="size-4 shrink-0 opacity-0" aria-hidden="true" />
                </button>
              ))}
            </div>
          </div>
        )}

        <DialogFooter className="gap-2 sm:justify-between sm:space-x-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          {otherAccounts.length > 0 ? (
            <Button variant="destructive" onClick={() => closeThen(logoutAllAccounts)}>
              <LogOut className="size-4" />
              退出全部账号
            </Button>
          ) : (
            <Button variant="destructive" onClick={() => closeThen(() => logoutCurrentAccount())}>
              <LogOut className="size-4" />
              退出当前账号
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
