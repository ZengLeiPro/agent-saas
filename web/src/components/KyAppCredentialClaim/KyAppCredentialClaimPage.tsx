import { useCallback, useEffect, useRef, useState } from 'react';
import { AuthShell } from '@/components/AuthShell';
import { LoginPage } from '@/components/LoginPage';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';
import {
  installationPath,
  kyAppRequest,
  kyAppV2Post,
  kyAppV2Request,
  KyAppManagementError,
} from '@/lib/kyAppManagementApi';
import type { EnrollmentOperationView } from '@/lib/kyAppManagementTypes';

interface ClaimedCredential {
  serviceCredential: string;
  installationKey: string;
  keyVersion: string;
  ackDeadlineAt: string;
}

const scopeNames: Record<string, string> = {
  'installation.activate': '完成本组织接入',
  'directory.snapshot': '读取组织成员目录',
  'directory.changes': '同步组织成员变化',
  'installation.keys.rotate': '安全更换接入身份',
};
const activeStatuses = new Set(['code_issued', 'exchanged', 'activating']);

export function KyAppCredentialClaimPage({
  installationId,
  initialTicket = '',
}: {
  installationId: string;
  initialTicket?: string;
}) {
  const { isAuthenticated, isLoading } = useAuth();
  const ticket = useRef(initialTicket);
  const legacyGeneration = useRef(0);
  const alive = useRef(true);
  const storageKey = `ky-app-enrollment:${installationId}`;
  const [operation, setOperation] = useState<EnrollmentOperationView>();
  const [phase, setPhase] = useState<'start' | 'checking' | 'review' | 'approving' | 'progress'>(
    'start',
  );
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [credential, setCredential] = useState<ClaimedCredential>();
  const [legacyPhase, setLegacyPhase] = useState<'confirm' | 'claiming' | 'shown' | 'gone'>(
    'confirm',
  );

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
      legacyGeneration.current += 1;
    };
  }, [isAuthenticated, refresh, storageKey]);

  useEffect(() => {
    if (!operation || !activeStatuses.has(operation.status)) return;
    const timer = window.setInterval(() => void refresh(operation.operationId), 2_000);
    return () => window.clearInterval(timer);
  }, [operation, refresh]);

  useEffect(() => {
    const clearLegacySecret = () => {
      if (document.visibilityState !== 'hidden') return;
      legacyGeneration.current += 1;
      setCredential(undefined);
      setLegacyPhase((current) =>
        current === 'shown' || current === 'claiming' ? 'gone' : current,
      );
    };
    const leave = () => {
      ticket.current = '';
      clearLegacySecret();
    };
    document.addEventListener('visibilitychange', clearLegacySecret);
    window.addEventListener('pagehide', leave);
    return () => {
      document.removeEventListener('visibilitychange', clearLegacySecret);
      window.removeEventListener('pagehide', leave);
    };
  }, []);

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
            ? '该业务系统暂未开放自动接入，可在下方使用旧版手动方式。'
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

  async function claimLegacy() {
    if (!ticket.current || legacyPhase !== 'confirm') {
      setError('旧版领取票据缺失或已经结束，请联系管理员重新签发。');
      return;
    }
    const current = ++legacyGeneration.current;
    setLegacyPhase('claiming');
    setError('');
    const value = ticket.current;
    ticket.current = '';
    try {
      const response = await kyAppRequest<{ credential: ClaimedCredential }>(
        installationPath(installationId, `/credentials/claim/${encodeURIComponent(value)}`),
      );
      if (
        alive.current &&
        current === legacyGeneration.current &&
        document.visibilityState !== 'hidden'
      ) {
        setCredential(response.credential);
        setLegacyPhase('shown');
      }
    } catch {
      if (!alive.current || current !== legacyGeneration.current) return;
      setLegacyPhase('gone');
      setError('旧版领取未完成，票据可能已使用或过期，请联系管理员核对。');
    }
  }

  function envText() {
    return credential
      ? `KY_SERVICE_CREDENTIAL=${credential.serviceCredential}\nKY_INSTALLATION_KEY=${credential.installationKey}\nKY_INSTALLATION_KEY_VERSION=${credential.keyVersion}\n`
      : '';
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

      {initialTicket && (
        <details className="rounded-lg border p-4">
          <summary className="cursor-pointer text-sm font-medium">手动配置旧版系统</summary>
          <div className="mt-3 space-y-3 text-sm">
            <p>仅当业务系统尚未支持自动接入时使用；该方式仍需要人工配置并重新发布。</p>
            {legacyPhase === 'confirm' && (
              <Button variant="outline" onClick={() => void claimLegacy()}>
                领取旧版配置
              </Button>
            )}
            {legacyPhase === 'claiming' && <p role="status">正在领取旧版配置…</p>}
            {credential && legacyPhase === 'shown' && (
              <>
                <pre className="whitespace-pre-wrap break-all rounded border p-3 text-xs">
                  {envText()}
                </pre>
                <p>请在 {credential.ackDeadlineAt} 前完成配置。</p>
                <Button
                  variant="outline"
                  onClick={() => void navigator.clipboard.writeText(envText())}
                >
                  复制旧版配置
                </Button>
              </>
            )}
            {legacyPhase === 'gone' && <p>本次旧版领取已结束，配置明文不会再次显示。</p>}
          </div>
        </details>
      )}
    </main>
  );
}
