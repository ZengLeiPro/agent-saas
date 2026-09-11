import type { ReactNode } from 'react';
import { ExternalLink, KeyRound, Loader2, Plus, RefreshCw, Save, Unplug, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SubscriptionAccounts } from './SubscriptionAccounts';
import { safeGrokVerificationUri } from './grokSubscriptionClient';
import { useGrokSubscription } from './useGrokSubscription';
import type { GrokSubscriptionState } from './subscriptionTypes';
export function GrokSubscriptionCard({
  readOnly,
  children,
}: {
  readOnly: boolean;
  children?: (state: GrokSubscriptionState | null) => ReactNode;
}) {
  const grok = useGrokSubscription(readOnly);
  const accounts = grok.state?.credentials ?? [];
  const activeSession =
    grok.session?.status === 'pending' || grok.session?.status === 'authorized_pending_publication';
  const busy = grok.working || activeSession;
  const coldValid =
    Number.isInteger(grok.quotaCooldownMinutes) &&
    grok.quotaCooldownMinutes >= 1 &&
    grok.quotaCooldownMinutes <= 10_080;
  const clientValid = /^[A-Za-z0-9._-]{1,256}$/.test(grok.oauthClientId);
  const verificationUri = safeGrokVerificationUri(grok.session?.verificationUri);
  const runtime = grok.state?.runtime;
  return (
    <Card id="grok-subscription" className="h-fit">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between gap-3 text-base">
          <span className="flex items-center gap-1.5">
            <KeyRound className="size-4 text-muted-foreground" />
            Grok 订阅鉴权
          </span>
          <Badge variant={accounts.some((account) => account.connected) ? 'secondary' : 'outline'}>
            {grok.unsupported
              ? '服务端未支持'
              : accounts.some((account) => account.connected)
                ? '已连接'
                : '未连接'}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {grok.loading && !grok.state ? (
          <div className="flex h-20 items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              平台级 Grok
              订阅账号池，按下方优先级使用。明确额度耗尽或永久授权失效时才切换账号；普通限流不会轮换账号规避限制。工具、审批和会话仍由本平台执行，不回退到
              API Key 计费。
            </p>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5 md:col-span-2">
                <Label htmlFor="grok-endpoint">Endpoint</Label>
                <Input id="grok-endpoint" value={grok.state?.config.endpoint ?? ''} disabled />
              </div>
              <label className="flex items-center gap-2 self-end pb-2 text-sm">
                <input
                  type="checkbox"
                  checked={grok.enabled}
                  disabled={grok.readOnly || busy || !accounts.length}
                  onChange={(event) => grok.setEnabled(event.target.checked)}
                />
                启用 Grok 订阅 transport
              </label>
              <div className="space-y-1.5">
                <Label htmlFor="grok-quota-cooldown">额度耗尽冷却（分钟）</Label>
                <Input
                  id="grok-quota-cooldown"
                  type="number"
                  min={1}
                  max={10_080}
                  value={grok.quotaCooldownMinutes}
                  disabled={grok.readOnly || busy}
                  onChange={(event) => grok.setQuotaCooldownMinutes(Number(event.target.value))}
                />
                <p className="text-xs text-muted-foreground">
                  冷却期间跳过该账号，到期按原优先级恢复探测。
                </p>
              </div>
            </div>
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">OAuth 客户端设置</summary>
              <div className="mt-2 space-y-1.5">
                <Label htmlFor="grok-oauth-client">公开 OAuth client ID</Label>
                <Input
                  id="grok-oauth-client"
                  value={grok.oauthClientId}
                  disabled={grok.readOnly || busy}
                  onChange={(event) => grok.setOauthClientId(event.target.value)}
                />
                <p className="text-muted-foreground">
                  仅填写 xAI 允许用于此部署的公开客户端标识，不是密钥。已登记账号仍使用签发时的
                  client ID 刷新。
                </p>
              </div>
            </details>
            <SubscriptionAccounts
              accounts={accounts}
              readOnly={grok.readOnly}
              working={busy}
              reorder={grok.reorder}
              startAuthorization={grok.startAuthorization}
              removeCredential={grok.removeCredential}
            />
            {runtime && (
              <div className="rounded-md border bg-muted/20 p-3 text-xs">
                <div className="font-medium">当前实例运行状态</div>
                <div className="mt-2 grid gap-1 text-muted-foreground md:grid-cols-2">
                  <div>最近请求：{formatTime(runtime.lastRequestAt)}</div>
                  <div>最近成功：{formatTime(runtime.lastSuccessAt)}</div>
                  <div>OAuth 最近刷新：{formatTime(runtime.oauth.lastRefreshAt)}</div>
                  <div>刷新代次：{runtime.oauth.lastRefreshGeneration ?? '未知'}</div>
                </div>
                {runtime.lastError && (
                  <p className="mt-2 text-destructive">最近请求错误：{runtime.lastError}</p>
                )}
                {runtime.oauth.lastRefreshError && (
                  <p className="mt-1 text-destructive">
                    刷新错误：{runtime.oauth.lastRefreshError}
                  </p>
                )}
                <p className="mt-2 text-muted-foreground">
                  当前采用完整历史 HTTP/SSE。此诊断窗口随实例重启清空；长期用量以平台账本为准。
                </p>
              </div>
            )}
            {grok.session && (
              <div
                className="rounded-md border border-primary/30 bg-primary/5 p-3"
                aria-live="polite"
              >
                <p className="text-sm font-medium">
                  {grok.session.status === 'pending'
                    ? '等待 xAI 授权确认'
                    : grok.session.status === 'authorized_pending_publication'
                      ? '已授权，尚未登记到平台'
                      : grok.session.status === 'expired'
                        ? '授权已过期'
                        : grok.session.status === 'denied'
                          ? '授权被拒绝'
                          : '授权未完成'}
                </p>
                {grok.session.status === 'pending' && (
                  <>
                    <p className="mt-2 text-xs text-muted-foreground">
                      在 xAI 页面输入以下一次性授权码：
                    </p>
                    <div className="mt-2 font-mono text-2xl font-semibold tracking-[0.25em]">
                      {grok.session.userCode}
                    </div>
                    {verificationUri && (
                      <a
                        className="mt-3 inline-flex items-center gap-1 text-sm text-primary underline"
                        href={verificationUri}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <ExternalLink className="size-3.5" />
                        打开 xAI 授权页面
                      </a>
                    )}
                    <p className="mt-2 text-xs text-muted-foreground">
                      弹窗被阻止时可点击链接。确认后会自动推进平台登记；刷新页面或服务重启后，未完成授权可能需要重新开始。
                    </p>
                  </>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  {grok.session.status === 'authorized_pending_publication' && (
                    <Button
                      size="sm"
                      disabled={grok.readOnly || grok.working}
                      onClick={() => void grok.complete()}
                    >
                      <Save className="size-3.5" />
                      继续登记
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={grok.working}
                    onClick={() => void grok.cancel()}
                  >
                    <X className="size-3.5" />
                    {activeSession ? '取消本次授权' : '关闭授权任务'}
                  </Button>
                </div>
              </div>
            )}
            {grok.error && (
              <p role="alert" className="text-sm text-destructive">
                {grok.error}
              </p>
            )}
            {grok.writePolicy?.canSave === false && (
              <p className="text-xs text-muted-foreground">
                {grok.writePolicy.message ?? '当前为只读配置状态'}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={grok.readOnly || busy}
                onClick={() => void grok.startAuthorization()}
              >
                {grok.working ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Plus className="size-3.5" />
                )}
                添加授权账号
              </Button>
              <Button
                size="sm"
                disabled={grok.readOnly || busy || !coldValid || !clientValid}
                onClick={() => void grok.save()}
              >
                <Save className="size-3.5" />
                保存设置
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={grok.working}
                aria-label="刷新 Grok 订阅状态" onClick={() => void grok.refresh()}
              >
                <RefreshCw className="size-3.5" />
                刷新
              </Button>
              {accounts.length > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  disabled={grok.readOnly || busy}
                  onClick={() => void grok.disconnect()}
                >
                  <Unplug className="size-3.5" />
                  断开全部并撤销
                </Button>
              )}
            </div>
            {children?.(grok.state)}
          </>
        )}
      </CardContent>
    </Card>
  );
}
function formatTime(value?: string): string {
  return value ? new Date(value).toLocaleString() : '尚无';
}
