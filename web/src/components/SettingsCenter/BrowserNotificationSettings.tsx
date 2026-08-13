import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bell, Loader2, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  disableCurrentWebPush,
  enableWebPush,
  fetchWebPushStatus,
  getCurrentPushSubscription,
  getCurrentWebPushRecord,
  getWebPushSupportReason,
  removeWebPushSubscription,
  type WebPushStatus,
  type WebPushSupportReason,
} from '@/lib/webPush';

export function BrowserNotificationSettings() {
  const supportReason = getWebPushSupportReason();
  const [status, setStatus] = useState<WebPushStatus | null>(null);
  const [current, setCurrent] = useState<PushSubscription | null>(null);
  const [permission, setPermission] = useState<NotificationPermission>(() => (
    'Notification' in window ? Notification.permission : 'default'
  ));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextStatus, nextCurrent] = await Promise.all([
        fetchWebPushStatus(),
        getCurrentPushSubscription(),
      ]);
      setStatus(nextStatus);
      setCurrent(nextCurrent);
      if ('Notification' in window) setPermission(Notification.permission);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const currentRecord = useMemo(() => (
    status ? getCurrentWebPushRecord(status, current) : undefined
  ), [current, status]);
  const enabled = permission === 'granted' && !!currentRecord;
  const disabled = loading || saving || supportReason !== 'supported' || !status?.configured;

  const handleToggle = async (checked: boolean) => {
    if (!status) return;
    setSaving(true);
    setError(null);
    try {
      if (checked) {
        if (!status.publicKey) throw new Error('服务端未提供 Web Push 公钥');
        await enableWebPush(status.publicKey);
      } else {
        await disableCurrentWebPush(status, current);
      }
      await refresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
      if ('Notification' in window) setPermission(Notification.permission);
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (subscriptionId: string) => {
    setSaving(true);
    setError(null);
    try {
      await removeWebPushSubscription(subscriptionId);
      if (currentRecord?.id === subscriptionId) await current?.unsubscribe().catch(() => undefined);
      await refresh();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setSaving(false);
    }
  };

  const guidance = describeState(supportReason, status, permission, enabled, !!current && !currentRecord);

  return (
    <div className="border-t pt-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Bell className="size-4" />
            浏览器桌面通知
          </div>
          <div className="mt-1 text-sm leading-6 text-muted-foreground">
            定时任务、后台 Agent 和等待确认时，通过系统通知中心提醒；通知只显示任务名称和状态。
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {saving ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
          <Switch
            checked={enabled}
            disabled={disabled}
            onCheckedChange={(checked) => { void handleToggle(checked); }}
            aria-label="浏览器桌面通知"
          />
        </div>
      </div>

      <div className="mt-3 rounded-lg bg-muted/45 px-3 py-2.5 text-sm leading-6 text-muted-foreground">
        {loading ? '正在检查浏览器通知状态…' : guidance}
      </div>
      {error ? <div className="mt-2 text-sm text-destructive">{error}</div> : null}

      {status && status.subscriptions.length > 0 ? (
        <div className="mt-4 space-y-2">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">已绑定设备</div>
          {status.subscriptions.map((subscription) => {
            const isCurrent = currentRecord?.id === subscription.id;
            return (
              <div key={subscription.id} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {subscription.deviceName}{isCurrent ? '（当前设备）' : ''}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    最近绑定：{new Date(subscription.updatedAt).toLocaleString('zh-CN')}
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  disabled={saving}
                  onClick={() => { void handleRemove(subscription.id); }}
                  aria-label={`移除 ${subscription.deviceName}`}
                >
                  <Trash2 className="size-4" />
                  移除
                </Button>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function describeState(
  supportReason: WebPushSupportReason,
  status: WebPushStatus | null,
  permission: NotificationPermission,
  enabled: boolean,
  hasUnboundLocalSubscription: boolean,
): string {
  if (supportReason === 'insecure') return '当前页面不是 HTTPS 安全上下文，浏览器不会开放 Web Push。请使用平台 HTTPS 地址。';
  if (supportReason !== 'supported') {
    if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
      return '当前 Safari 环境未开放 Web Push。iPhone/iPad 需使用受支持的系统版本，并先把平台“添加到主屏幕”后从主屏幕打开；站内结果会话仍正常保留。';
    }
    return '当前浏览器或系统版本不支持标准 Service Worker + Web Push，请升级 Chrome、Edge 或受支持的 Safari。站内结果会话仍正常保留。';
  }
  if (!status?.configured) return '服务端尚未配置 VAPID 密钥，暂不能开启桌面通知；站内结果会话不受影响。';
  if (permission === 'denied') return '通知权限已被浏览器拒绝。请在地址栏左侧“网站设置 → 通知”改为允许，并在 Windows“设置 → 系统 → 通知”或 macOS“系统设置 → 通知”中允许该浏览器。';
  if (enabled) return '此设备已开启。网页关闭或未停留在会话页时，只要浏览器和系统允许，通知仍会进入系统通知中心。若收不到，请检查系统通知设置；网页标准 API 无法读取操作系统总开关。';
  if (hasUnboundLocalSubscription) return '此浏览器存在旧订阅但未绑定当前账号，点击开关可重新绑定。';
  return '当前设备未开启。点击开关后浏览器才会主动询问授权；拒绝授权不会影响任务执行和站内结果。';
}
