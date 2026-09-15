import { useCallback, useEffect, useRef, useState } from 'react';
import { AuthShell } from '@/components/AuthShell';
import { LoginPage } from '@/components/LoginPage';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';
import { kyAppV2Post, kyAppV2Request, KyAppManagementError } from '@/lib/kyAppManagementApi';
import type { EnrollmentOperationView } from '@/lib/kyAppManagementTypes';

const scopeNames: Record<string, string> = {
  'installation.activate': '完成本组织接入',
  'directory.snapshot': '读取组织成员目录',
  'directory.changes': '同步组织成员变化',
  'installation.keys.rotate': '安全更换接入身份',
};
const activeStatuses = new Set(['code_issued', 'exchanged', 'activating']);

export function KyAppCredentialClaimPage({ installationId }: { installationId: string }) {
  const { isAuthenticated, isLoading } = useAuth();
  const alive = useRef(true);
  const storageKey = `ky-app-enrollment:${installationId}`;
  const [operation, setOperation] = useState<EnrollmentOperationView>();
  const [phase, setPhase] = useState<'start' | 'checking' | 'review' | 'approving' | 'progress'>(
    'start',
  );
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const applyOperation = useCallback(
    (next: EnrollmentOperationView) => {
      setOperation(next);
      if (next.status === 'awaiting_consent') setPhase('review');
      else if (next.status === 'ready') {
        setPhase('progress');
        try {
          sessionStorage.removeItem(storageKey);
        } catch {
          // 隐私模式下 storage 不可用不影响接入。
        }
      } else if (activeStatuses.has(next.status)) setPhase('progress');
      else {
        setPhase('start');
        if (next.status === 'expired' || next.status === 'cancelled') {
          try {
            sessionStorage.removeItem(storageKey);
          } catch {
            // ignore
          }
        }
      }
    },
    [storageKey],
  );

  const refresh = useCallback(
    async (operationId: string) => {
      try {
        const response = await kyAppV2Request<{ operation: EnrollmentOperationView }>(
          `/enrollment-operations/${encodeURIComponent(operationId)}`,
        );
        if (alive.current) applyOperation(response.operation);
      } catch (reason) {
        if (!alive.current) return;
        if (reason instanceof KyAppManagementError && reason.status === 404) {
          try {
            sessionStorage.removeItem(storageKey);
          } catch {
            // ignore
          }
        } else {
          setError('暂时无法读取原接入进度，请稍后刷新；系统不会重复创建接入。');
        }
      }
    },
    [applyOperation, storageKey],
  );

  useEffect(() => {
    alive.current = true;
    if (isAuthenticated) {
      try {
        const operationId = sessionStorage.getItem(storageKey);
        if (operationId) void refresh(operationId);
      } catch {
        // 隐私模式下 storage 不可用时仍可完成本次页面流程。
      }
    }
    return () => {
      alive.current = false;
    };
  }, [isAuthenticated, refresh, storageKey]);

  useEffect(() => {
    if (!operation || !activeStatuses.has(operation.status)) return;
    const timer = window.setInterval(() => void refresh(operation.operationId), 2_000);
    return () => window.clearInterval(timer);
  }, [operation, refresh]);

  async function begin() {
    if (phase !== 'start') return;
    setPhase('checking');
    setError('');
    let operationId = '';
    try {
      operationId = sessionStorage.getItem(storageKey) ?? crypto.randomUUID();
      sessionStorage.setItem(storageKey, operationId);
      const response = await kyAppV2Post<{ operation: EnrollmentOperationView }>(
        `/installations/${encodeURIComponent(installationId)}/enrollment-operations`,
        { operationId },
      );
      applyOperation(response.operation);
    } catch (reason) {
      setPhase('start');
      setError(
        reason instanceof KyAppManagementError && reason.status === 403
          ? '当前账号不是本次接入的负责人，请使用平台管理员或登记的技术联系人账号。'
          : reason instanceof KyAppManagementError && reason.status === 409
            ? '该业务系统暂未开放自动接入，请联系平台管理员检查 V2 接入配置。'
            : `安全检查暂未完成。${operationId ? '请刷新页面查询原进度，不要重复发起。' : '请稍后重试。'}`,
      );
    }
  }

  async function approve() {
    if (!operation || !password || phase !== 'review') return;
    setPhase('approving');
    setError('');
    try {
      const response = await kyAppV2Post<{ redirectUrl: string }>(
        `/enrollment-operations/${encodeURIComponent(operation.operationId)}/approve`,
        { password },
      );
      setPassword('');
      window.location.assign(response.redirectUrl);
    } catch (reason) {
      setPassword('');
      setPhase('review');
      setError(
        reason instanceof KyAppManagementError && reason.status === 401
          ? '身份确认未通过，请重新输入当前账号密码。'
          : '授权结果暂时不确定。页面只会查询原进度，不会重复授权。',
      );
      void refresh(operation.operationId);
    }
  }

  if (isLoading) return <p role="status">正在验证登录状态…</p>;
  if (!isAuthenticated) {
    return (
      <AuthShell>
        <p className="mb-4 text-sm">请使用平台管理员或登记的技术联系人账号登录，随后继续授权。</p>
        <LoginPage signupEnabled={false} />
      </AuthShell>
    );
  }

  return (
    <main className="mx-auto max-w-xl space-y-5 p-6">
      <div>
        <h1 className="text-xl font-semibold">授权并自动接入</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          确认后，系统会自动完成组织接入；业务系统无需停机或重新发布。
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {phase === 'start' && <Button onClick={() => void begin()}>开始安全检查</Button>}
      {phase === 'checking' && <p role="status">正在确认业务系统身份和接入范围…</p>}

      {operation && phase === 'review' && (
        <section className="space-y-4 rounded-lg border p-4">
          <h2 className="font-medium">请确认本次接入</h2>
          <dl className="grid grid-cols-[7rem_1fr] gap-2 text-sm">
            <dt>组织</dt>
            <dd>{operation.organization.name}</dd>
            <dt>业务系统</dt>
            <dd>{operation.system.name}</dd>
            <dt>业务地址</dt>
            <dd className="break-all">{operation.origin}</dd>
            <dt>系统身份</dt>
            <dd>{operation.keyFingerprint ?? '待确认'}</dd>
          </dl>
          <div>
            <p className="text-sm font-medium">允许事项</p>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
              {operation.scopes.map((scope) => (
                <li key={scope}>{scopeNames[scope] ?? scope}</li>
              ))}
            </ul>
          </div>
          <label className="block text-sm">
            输入当前账号密码再次确认
            <input
              aria-label="当前账号密码"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="mt-1 w-full rounded border bg-background p-2"
            />
          </label>
          <div className="flex gap-2">
            <Button disabled={!password} onClick={() => void approve()}>
              确认授权并接入
            </Button>
            <Button variant="outline" onClick={() => setPhase('start')}>
              取消
            </Button>
          </div>
        </section>
      )}

      {(phase === 'approving' || phase === 'progress') && operation && (
        <section className="space-y-3 rounded-lg border p-4">
          <h2 className="font-medium">
            {operation.status === 'ready' ? '已成功接入组织' : '正在完成自动接入'}
          </h2>
          <p role="status" className="text-sm">
            {operation.status === 'code_issued'
              ? '授权已确认，正在交给业务系统处理。'
              : operation.status === 'exchanged' || operation.status === 'activating'
                ? '业务系统已收到授权，正在进行最后检查。'
                : operation.status === 'ready'
                  ? '组织成员现在可以从 Agent 中使用该业务系统。'
                  : '正在处理，请勿重复发起。'}
          </p>
          <Button variant="outline" onClick={() => void refresh(operation.operationId)}>
            刷新进度
          </Button>
        </section>
      )}
    </main>
  );
}
