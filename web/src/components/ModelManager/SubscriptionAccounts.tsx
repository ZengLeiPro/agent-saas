import { ArrowDown, ArrowUp, KeyRound, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { SubscriptionCredentialState } from './subscriptionTypes';
export function formatCooldownRemaining(cooldownUntil: string): string {
  const remainingSeconds = Math.max(0, Math.ceil((Date.parse(cooldownUntil) - Date.now()) / 1000));
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  return `${minutes} 分 ${seconds} 秒`;
}

/** Shared priority controls; provider routes and configuration transactions stay outside the view. */
export function SubscriptionAccounts({
  accounts,
  readOnly: effectiveReadOnly,
  working,
  reorder,
  startAuthorization,
  removeCredential,
}: {
  accounts: SubscriptionCredentialState[];
  readOnly: boolean;
  working: boolean;
  reorder: (from: number, to: number) => void | Promise<void>;
  startAuthorization: (ref?: string) => void | Promise<void>;
  removeCredential: (account: SubscriptionCredentialState) => void | Promise<void>;
}) {
  return (
    <>
      {accounts.length > 0 && (
        <div className="space-y-2">
          <div>
            <div className="text-sm font-medium">授权账号优先级</div>
            <div className="text-xs text-muted-foreground">
              新顺序作用于后续模型请求，不改变已发出的请求。
            </div>
          </div>
          {accounts.map((account, index) => (
            <div
              key={account.id ?? `${account.email ?? 'account'}-${index}`}
              className="rounded-md border bg-muted/20 p-3 text-xs"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">优先级 {index + 1}</Badge>
                  <span>{account.email ?? `尾号 ${account.accountIdHint ?? '未知'}`}</span>
                  {account.availability === 'quota_cooldown' ? (
                    <Badge variant="outline">额度冷却</Badge>
                  ) : account.availability === 'auth_unavailable' ? (
                    <Badge variant="destructive">需重授权</Badge>
                  ) : account.connected ? (
                    <Badge variant="secondary">可用</Badge>
                  ) : (
                    <Badge variant="outline">异常</Badge>
                  )}
                </div>
                <div className="flex flex-wrap gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2"
                    disabled={effectiveReadOnly || working || index === 0}
                    onClick={() => void reorder(index, index - 1)}
                    title="上移优先级"
                  >
                    <ArrowUp className="size-3.5" />
                    上移
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2"
                    disabled={effectiveReadOnly || working || index === accounts.length - 1}
                    onClick={() => void reorder(index, index + 1)}
                    title="下移优先级"
                  >
                    <ArrowDown className="size-3.5" />
                    下移
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2"
                    disabled={effectiveReadOnly || working || !account.id}
                    onClick={() => void startAuthorization(account.id)}
                  >
                    <KeyRound className="size-3.5" />
                    重授权
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-destructive hover:text-destructive"
                    disabled={effectiveReadOnly || working || !account.id}
                    onClick={() => void removeCredential(account)}
                  >
                    <Trash2 className="size-3.5" />
                    删除
                  </Button>
                </div>
              </div>
              <div className="mt-1 text-muted-foreground">
                绑定指纹：{account.accountBindingHash ?? '未知'}
                {account.expiresAt
                  ? ` · access token ${account.accessTokenExpired ? '已到期，将自动刷新' : `到期 ${new Date(account.expiresAt).toLocaleString()}`}`
                  : ''}
              </div>
              {account.availability === 'quota_cooldown' && account.cooldownUntil && (
                <div className="mt-1 text-amber-700 dark:text-amber-400">
                  冷却至 {new Date(account.cooldownUntil).toLocaleString()}
                  {` · 剩余 ${formatCooldownRemaining(account.cooldownUntil)}`}
                  {account.lastFailureCode ? ` · ${account.lastFailureCode}` : ''}
                </div>
              )}
              {account.availability === 'auth_unavailable' && (
                <div className="mt-1 text-destructive">
                  授权不可用，请重授权
                  {account.lastFailureCode ? ` · ${account.lastFailureCode}` : ''}
                </div>
              )}
              {account.error && <div className="mt-1 text-destructive">{account.error}</div>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
