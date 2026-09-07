import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { LoginPage } from '@/components/LoginPage';
import { AuthShell } from '@/components/AuthShell';
import { Button } from '@/components/ui/button';
import { installationPath, kyAppRequest, KyAppManagementError } from '@/lib/kyAppManagementApi';
interface ClaimedCredential {
  serviceCredential: string;
  installationKey: string;
  keyVersion: string;
  ackDeadlineAt: string;
}
export function KyAppCredentialClaimPage({ installationId }: { installationId: string }) {
  const { isAuthenticated, isLoading } = useAuth();
  const ticket = useRef('');
  const generation = useRef(0);
  const alive = useRef(true);
  const [credential, setCredential] = useState<ClaimedCredential>();
  const [phase, setPhase] = useState<'confirm' | 'claiming' | 'shown' | 'gone'>('confirm');
  const [error, setError] = useState('');
  useLayoutEffect(() => {
    alive.current = true;
    const captured = new URLSearchParams(window.location.hash.slice(1)).get('ticket');
    if (captured) {
      ticket.current = captured;
      window.history.replaceState(window.history.state, '', window.location.pathname);
    }
    return () => {
      alive.current = false;
      generation.current += 1;
    };
  }, []);
  useEffect(() => {
    const clear = () => {
      if (document.visibilityState === 'hidden') {
        generation.current += 1;
        setCredential(undefined);
        setPhase((current) => (current === 'shown' || current === 'claiming' ? 'gone' : current));
      }
    };
    const leave = () => {
      ticket.current = '';
      generation.current += 1;
      setCredential(undefined);
      setPhase('gone');
    };
    document.addEventListener('visibilitychange', clear);
    window.addEventListener('pagehide', leave);
    window.addEventListener('popstate', leave);
    return () => {
      document.removeEventListener('visibilitychange', clear);
      window.removeEventListener('pagehide', leave);
      window.removeEventListener('popstate', leave);
    };
  }, []);
  useEffect(() => {
    if (!isAuthenticated) {
      generation.current += 1;
      setCredential(undefined);
      setPhase((current) => (current === 'claiming' || current === 'shown' ? 'gone' : current));
    }
  }, [isAuthenticated]);
  async function claim() {
    if (!ticket.current || phase !== 'confirm') {
      setError('领取票据缺失，请联系管理员重新签发。');
      return;
    }
    const current = ++generation.current;
    setPhase('claiming');
    setError('');
    const value = ticket.current;
    ticket.current = '';
    try {
      const response = await kyAppRequest<{ credential: ClaimedCredential }>(
        installationPath(installationId, `/credentials/claim/${encodeURIComponent(value)}`),
      );
      if (
        alive.current &&
        current === generation.current &&
        document.visibilityState !== 'hidden'
      ) {
        setCredential(response.credential);
        setPhase('shown');
      }
    } catch (reason) {
      if (!alive.current || current !== generation.current) return;
      setPhase('gone');
      setError(
        reason instanceof KyAppManagementError && reason.status === 403
          ? '当前账号不是登记的技术联系人'
          : reason instanceof KyAppManagementError && [404, 409].includes(reason.status)
            ? '票据不存在、已使用或已过期，请联系管理员重新签发。'
            : '领取未完成，票据可能已使用，请联系管理员核对后重新签发。',
      );
    }
  }
  function envText() {
    return credential
      ? `KY_SERVICE_CREDENTIAL=${credential.serviceCredential}\nKY_INSTALLATION_KEY=${credential.installationKey}\nKY_INSTALLATION_KEY_VERSION=${credential.keyVersion}\n`
      : '';
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(envText());
    } catch {
      setError('复制失败，请在本次页面内手动保存。');
    }
  }
  function download() {
    if (!credential || !window.confirm('下载文件包含服务凭据明文。请仅保存到受控位置，确认下载？'))
      return;
    const url = URL.createObjectURL(new Blob([envText()], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'ky-app.env';
    link.click();
    URL.revokeObjectURL(url);
  }
  if (isLoading) return <p role="status">正在验证登录状态…</p>;
  if (!isAuthenticated)
    return (
      <AuthShell>
        <p className="mb-4 text-sm">请使用登记的技术联系人账号登录，随后继续领取。</p>
        <LoginPage signupEnabled={false} />
      </AuthShell>
    );
  return (
    <main className="mx-auto max-w-xl space-y-4 p-6">
      <h1 className="text-xl font-semibold">一次性领取服务凭据</h1>
      <p>安装实例：{installationId}</p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {phase === 'confirm' && (
        <>
          <p>
            凭据只展示一次，切换标签页、离开或刷新后将无法再次查看。请确认已准备好在业务系统中安全装配。
          </p>
          <Button onClick={() => void claim()}>确认风险并领取</Button>
        </>
      )}
      {phase === 'claiming' && <p role="status">正在领取…</p>}
      {credential && phase === 'shown' && (
        <>
          <pre className="whitespace-pre-wrap break-all rounded border p-3 text-xs">
            {envText()}
          </pre>
          <p className="text-sm">请在 {credential.ackDeadlineAt} 前完成装配与确认。</p>
          <div className="flex gap-2">
            <Button onClick={() => void copy()}>复制配置</Button>
            <Button variant="outline" onClick={download}>
              下载 .env
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setCredential(undefined);
                setPhase('gone');
              }}
            >
              清除明文
            </Button>
          </div>
        </>
      )}
      {phase === 'gone' && <p>本次领取已结束，凭据明文不会再次显示。</p>}
    </main>
  );
}
