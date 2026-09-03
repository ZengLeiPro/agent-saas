import { useCallback, useEffect, useState } from 'react';
import { Loader2, RotateCcw } from 'lucide-react';
import type { LoginLogEntry, LoginLogResponse } from '@agent/shared';

import {
  useSettingsDirtyEntry,
  useSettingsDirtyNavigation,
} from '@/components/PersonalSettings/dirtyRegistry';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { authFetch } from '@/lib/authFetch';

const eventLabels: Readonly<Record<string, string>> = {
  login_success: '登录成功',
  login_fail: '登录失败',
  user_password_changed: '密码已变更',
  user_disabled: '账号已停用',
  user_enabled: '账号已启用',
};

export function MemberAccountSecurity({
  tenantId,
  userId,
  username,
  displayName,
}: {
  tenantId: string;
  userId: string;
  username: string;
  displayName: string;
}) {
  const [entries, setEntries] = useState<LoginLogEntry[]>([]);
  const [logsLoading, setLogsLoading] = useState(true);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetDone, setResetDone] = useState(false);
  const requestDirtyNavigation = useSettingsDirtyNavigation();

  const loadLogs = useCallback(async () => {
    setLogsLoading(true);
    setLogsError(null);
    try {
      const params = new URLSearchParams({ username, tenantId, offset: '0', limit: '20' });
      const response = await authFetch(`/api/auth/login-logs?${params.toString()}`);
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `HTTP ${response.status}`);
      }
      const body = (await response.json()) as LoginLogResponse;
      setEntries(body.entries);
    } catch (cause) {
      setLogsError(cause instanceof Error ? cause.message : '登录记录读取失败');
    } finally {
      setLogsLoading(false);
    }
  }, [tenantId, username]);

  useEffect(() => {
    void loadLogs();
  }, [loadLogs]);

  const clearDraft = () => {
    setPassword('');
    setConfirmPassword('');
    setResetError(null);
    setResetDone(false);
  };
  const close = () => {
    setDialogOpen(false);
    clearDraft();
  };
  const submit = async () => {
    if (password.length < 6) {
      setResetError('密码至少 6 位');
      return false;
    }
    if (password !== confirmPassword) {
      setResetError('两次输入的密码不一致');
      return false;
    }
    setResetting(true);
    setResetError(null);
    try {
      const response = await authFetch(`/api/auth/users/${encodeURIComponent(userId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || '密码重置失败');
      }
      setPassword('');
      setConfirmPassword('');
      setResetDone(true);
      await loadLogs();
      return true;
    } catch (cause) {
      setResetError(cause instanceof Error ? cause.message : '密码重置失败');
      return false;
    } finally {
      setResetting(false);
    }
  };

  useSettingsDirtyEntry({
    id: `member-password-reset:${tenantId}:${userId}`,
    label: `重置 ${displayName || username} 的密码`,
    dirty: dialogOpen && Boolean(password || confirmPassword),
    save: async () => {
      if (!(await submit())) throw new Error('Password reset failed');
    },
    discard: clearDraft,
    secret: true,
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4">
        <div>
          <div className="font-medium">账号安全</div>
          <div className="mt-1 text-xs text-muted-foreground">
            账号 {username} · 密码不会在页面或日志中回显
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            clearDraft();
            setDialogOpen(true);
          }}
        >
          重置密码
        </Button>
      </div>

      <div className="rounded-xl border bg-card">
        <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
          <div>
            <div className="font-medium">最近登录记录</div>
            <div className="mt-0.5 text-xs text-muted-foreground">当前成员最近 20 条账号事件</div>
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => void loadLogs()}
            disabled={logsLoading}
          >
            {logsLoading ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RotateCcw className="size-4" />
            )}
            刷新
          </Button>
        </div>
        {logsError ? (
          <div className="p-4 text-sm text-destructive" role="alert">
            {logsError}
          </div>
        ) : null}
        {!logsLoading && !logsError && entries.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">暂无登录记录</div>
        ) : null}
        {entries.length ? (
          <div className="divide-y">
            {entries.map((entry, index) => (
              <div
                key={`${entry.timestamp}-${entry.event}-${index}`}
                className="grid gap-1 px-4 py-3 text-sm sm:grid-cols-[10rem_1fr_auto] sm:items-center sm:gap-3"
              >
                <span className="text-xs text-muted-foreground">
                  {new Date(entry.timestamp).toLocaleString()}
                </span>
                <span>{eventLabels[entry.event] ?? entry.detail ?? entry.event}</span>
                <span className="text-xs text-muted-foreground">
                  {entry.channel} · {entry.ip}
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open) requestDirtyNavigation(close);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>重置密码</DialogTitle>
            <DialogDescription>为 {displayName || username} 设置新密码。</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              aria-label="新密码"
              type="password"
              autoComplete="new-password"
              placeholder="新密码（至少 6 位）"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setResetDone(false);
              }}
              disabled={resetting}
            />
            <Input
              aria-label="确认新密码"
              type="password"
              autoComplete="new-password"
              placeholder="再次输入新密码"
              value={confirmPassword}
              onChange={(event) => {
                setConfirmPassword(event.target.value);
                setResetDone(false);
              }}
              disabled={resetting}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !resetting) void submit();
              }}
            />
            {resetError ? (
              <div className="text-sm text-destructive" role="alert">
                {resetError}
              </div>
            ) : null}
            {resetDone ? (
              <div className="text-sm text-emerald-600" role="status">
                密码已重置
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => requestDirtyNavigation(close)}
              disabled={resetting}
            >
              取消
            </Button>
            <Button type="button" onClick={() => void submit()} disabled={resetting}>
              {resetting ? '正在重置…' : '确认重置'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
