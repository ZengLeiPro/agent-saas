import { useState } from 'react';
import { Loader2 } from 'lucide-react';

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

export function MemberPasswordResetAction({
  userId,
  displayName,
  buttonLabel = '重置密码',
  size,
}: {
  userId: string;
  displayName: string;
  buttonLabel?: string;
  size?: 'sm';
}) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [done, setDone] = useState(false);
  const requestDirtyNavigation = useSettingsDirtyNavigation();

  const clearDraft = () => {
    setPassword('');
    setConfirmPassword('');
    setError(null);
    setDone(false);
  };

  const close = () => {
    setOpen(false);
    clearDraft();
  };

  const submit = async (): Promise<boolean> => {
    if (password.length < 6) {
      setError('新密码至少 6 位');
      return false;
    }
    if (password !== confirmPassword) {
      setError('两次输入的新密码不一致');
      return false;
    }
    setResetting(true);
    setError(null);
    setDone(false);
    try {
      const response = await authFetch(`/api/auth/users/${userId}/password`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPassword: password }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || '密码重置失败');
      }
      setPassword('');
      setConfirmPassword('');
      setDone(true);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '密码重置失败');
      return false;
    } finally {
      setResetting(false);
    }
  };

  useSettingsDirtyEntry({
    id: `member-password-reset:${userId}`,
    label: `重置 ${displayName} 的密码`,
    dirty: open && Boolean(password || confirmPassword),
    save: async () => {
      if (!(await submit())) throw new Error('Password reset failed');
    },
    discard: clearDraft,
    secret: true,
  });

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size={size}
        aria-label={buttonLabel}
        onClick={() => {
          clearDraft();
          setOpen(true);
        }}
      >
        重置密码
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) requestDirtyNavigation(close);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>重置密码</DialogTitle>
            <DialogDescription>为 {displayName} 设置新密码；完成后该账号的旧登录态将失效。</DialogDescription>
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
                setDone(false);
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
                setDone(false);
              }}
              disabled={resetting}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !resetting) void submit();
              }}
            />
            {error ? <div className="text-sm text-destructive" role="alert">{error}</div> : null}
            {done ? <div className="text-sm text-emerald-600" role="status">密码已重置</div> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => requestDirtyNavigation(close)} disabled={resetting}>
              取消
            </Button>
            <Button type="button" onClick={() => void submit()} disabled={resetting}>
              {resetting ? <><Loader2 className="size-4 animate-spin" />正在重置…</> : '确认重置'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
