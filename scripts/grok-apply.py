from pathlib import Path
import re
root=Path('web/src/components/ModelManager')
def put(path,text):
    p=root/path;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text.lstrip('\n'))
p=root/'CodexSubscriptionCard.tsx';s=p.read_text()
a=s.index('type CodexRuntimeStatus =');b=s.index('type CodexSubscriptionState =',a)
types=s[a:b].replace('type CodexRuntimeStatus','export type SubscriptionRuntimeStatus').replace('type CodexCredentialState','export type SubscriptionCredentialState')
put('subscriptionTypes.ts', 'import type { AdminConfigResponseMetadata } from "@/hooks/useAdminConfigWritePolicy";\n'+types+'''export type GrokSubscriptionState = AdminConfigResponseMetadata & {
  config: { enabled: boolean; quotaCooldownMinutes: number; endpoint: string; oauthClientId: string; credentialCount: number };
  credentials: SubscriptionCredentialState[]; runtime?: SubscriptionRuntimeStatus; warning?: string;
};
export type GrokDeviceSession = {
  sessionId: string; status: 'pending' | 'authorized_pending_publication' | 'applied' | 'expired' | 'denied' | 'error';
  expiresAt: string; intervalMs?: number; intervalSeconds?: number;
  userCode?: string; verificationUri?: string; error?: string;
};
''')
s=s[:a]+s[b:]
a=s.index('export function formatCooldownRemaining(');b=s.index('function accountList(',a);format_fn=s[a:b];s=s[:a]+s[b:]
a=s.index('            {accounts.length > 0 && (');b=s.index('            {state?.runtime && (',a);accounts_jsx=s[a:b]
s=s[:a]+'''            <SubscriptionAccounts accounts={accounts} readOnly={effectiveReadOnly} working={working}
              reorder={reorder} startAuthorization={startAuthorization} removeCredential={removeCredential} />

'''+s[b:]
s='''import type { SubscriptionRuntimeStatus as CodexRuntimeStatus, SubscriptionCredentialState as CodexCredentialState } from './subscriptionTypes';
import { SubscriptionAccounts } from './SubscriptionAccounts';
export { formatCooldownRemaining } from './SubscriptionAccounts';
'''+s
s=s.replace('<Card className="h-fit">','<Card id="codex-subscription" className="h-fit">',1)
# Remove only icon imports no longer referenced after extracting the account list.
match=re.search(r'import \{ ([^}]+) \} from "lucide-react";',s);assert match
rest=s[:match.start()]+s[match.end():];icons=[x.strip() for x in match.group(1).split(',')]
icons=[x for x in icons if re.search(r'\b'+re.escape(x)+r'\b',rest)]
s=s[:match.start()]+'import { '+', '.join(icons)+' } from "lucide-react";'+s[match.end():];p.write_text(s)
put('SubscriptionAccounts.tsx','''import { ArrowDown, ArrowUp, KeyRound, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { SubscriptionCredentialState } from './subscriptionTypes';
'''+format_fn+'''/** Shared priority controls; provider routes and configuration transactions stay outside the view. */
export function SubscriptionAccounts({ accounts, readOnly: effectiveReadOnly, working, reorder, startAuthorization, removeCredential }: {
  accounts: SubscriptionCredentialState[]; readOnly: boolean; working: boolean;
  reorder: (from: number, to: number) => void | Promise<void>;
  startAuthorization: (ref?: string) => void | Promise<void>;
  removeCredential: (account: SubscriptionCredentialState) => void | Promise<void>;
}) {
  return (<>
'''+accounts_jsx+'''  </>);
}
''')
put('grokSubscriptionClient.ts', '''import type { GrokDeviceSession, GrokSubscriptionState } from './subscriptionTypes';
export const GROK_ADMIN_API = '/api/admin/grok-subscription';
export async function readSubscriptionJson<T>(response: Response): Promise<T & { error?: string; code?: string }> {
  return await response.json().catch(() => ({})) as T & { error?: string; code?: string };
}
export function safeGrokVerificationUri(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['auth.x.ai', 'accounts.x.ai', 'x.ai'].includes(url.hostname)
      && !url.port && !url.username && !url.password && !url.hash ? url.href : undefined;
  } catch { return undefined; }
}
export function validGrokSession(session: GrokDeviceSession): boolean {
  return typeof session.sessionId === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(session.sessionId)
    && Number.isFinite(Date.parse(session.expiresAt)) && session.status === 'pending'
    && typeof session.userCode === 'string' && session.userCode.length > 0 && session.userCode.length <= 128
    && !!safeGrokVerificationUri(session.verificationUri);
}
export function grokPollInterval(session: Pick<GrokDeviceSession, 'intervalMs' | 'intervalSeconds'>): number {
  const value = session.intervalMs ?? (session.intervalSeconds ?? 5) * 1000;
  return Number.isFinite(value) ? Math.max(1000, Math.min(300_000, value)) : 5000;
}
export function validGrokState(value: GrokSubscriptionState | undefined): value is GrokSubscriptionState {
  return !!value?.config && Array.isArray(value.credentials) && typeof value.config.enabled === 'boolean';
}
''')
put('useGrokSubscription.ts', '''import { useCallback, useEffect, useRef, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import { useAdminConfigWritePolicy } from '@/hooks/useAdminConfigWritePolicy';
import { GROK_ADMIN_API, grokPollInterval, readSubscriptionJson, safeGrokVerificationUri, validGrokSession, validGrokState } from './grokSubscriptionClient';
import type { GrokDeviceSession, GrokSubscriptionState, SubscriptionCredentialState } from './subscriptionTypes';
/** Each card owns its own authorization, revision and operation state. No token enters the client. */
export function useGrokSubscription(readOnly: boolean) {
  const write = useAdminConfigWritePolicy(readOnly);
  const { acceptMetadata } = write;
  const [state, setState] = useState<GrokSubscriptionState | null>(null);
  const [session, setSession] = useState<GrokDeviceSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [quotaCooldownMinutes, setQuotaCooldownMinutes] = useState(60);
  const [oauthClientId, setOauthClientId] = useState('');
  const mounted = useRef(true);
  const completing = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const applyState = useCallback((next: GrokSubscriptionState) => {
    if (!mounted.current) return;
    acceptMetadata(next); setState(next); setUnsupported(false);
    setEnabled(next.config.enabled); setQuotaCooldownMinutes(next.config.quotaCooldownMinutes ?? 60);
    setOauthClientId(next.config.oauthClientId ?? ''); setError(next.warning ?? null);
  }, [acceptMetadata]);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await authFetch(GROK_ADMIN_API);
      if ([404, 501].includes(response.status)) {
        setUnsupported(true); setState(null); setError('当前服务端尚未支持 Grok 订阅，请完成服务端升级后刷新。'); return;
      }
      const data = await readSubscriptionJson<GrokSubscriptionState>(response);
      if (!response.ok || !validGrokState(data)) throw new Error(data.error ?? `HTTP ${response.status}`);
      applyState(data);
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Grok 状态读取失败'); }
    finally { if (mounted.current) setLoading(false); }
  }, [applyState]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (unsupported || working || !state?.credentials.some((account) => account.availability && account.availability !== 'available')) return;
    const timer = setInterval(() => { void refresh(); }, 30_000); return () => clearInterval(timer);
  }, [refresh, state, unsupported, working]);
  const complete = useCallback(async (current: GrokDeviceSession | null = session) => {
    if (!current || current.status !== 'authorized_pending_publication' || completing.current) return;
    completing.current = true; setWorking(true); setError(null);
    try {
      if (write.readOnly) throw new Error('当前配置不可写；外部授权已完成，尚未登记到平台。');
      const confirmation = write.confirmMutation();
      if (confirmation === null) { setError('外部授权已完成，尚未登记到平台；可在授权有效期内继续登记。'); return; }
      const response = await write.mutationFetch(`${GROK_ADMIN_API}/device/${encodeURIComponent(current.sessionId)}/complete`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(write.bodyMetadata(confirmation)),
      });
      const data = await readSubscriptionJson<GrokSubscriptionState & { status: string }>(response);
      if (!response.ok || data.status !== 'applied' || !validGrokState(data)) throw new Error(data.error ?? `HTTP ${response.status}`);
      applyState(data); if (mounted.current) setSession(null);
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Grok 登记未完成，请先刷新确认结果'); }
    finally { completing.current = false; if (mounted.current) setWorking(false); }
  }, [applyState, session, write]);
  useEffect(() => {
    if (!session || session.status !== 'pending' || unsupported || write.readOnly) return;
    let cancelled = false; let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const poll = async () => {
      if (Date.now() >= Date.parse(session.expiresAt)) {
        setSession({ ...session, status: 'expired', userCode: undefined, verificationUri: undefined }); setError('Grok 授权码已过期，请重新发起授权。'); return;
      }
      try {
        const response = await authFetch(`${GROK_ADMIN_API}/device/${encodeURIComponent(session.sessionId)}/poll`, { method: 'POST', signal: controller.signal });
        const data = await readSubscriptionJson<GrokDeviceSession>(response); if (cancelled) return;
        if (response.status === 410 || data.status === 'expired') {
          setSession({ ...session, status: 'expired', userCode: undefined, verificationUri: undefined }); setError('Grok 授权码已过期，请重新发起授权。'); return;
        }
        if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
        if (data.status === 'authorized_pending_publication') {
          const next = { ...session, status: data.status, userCode: undefined, verificationUri: undefined };
          setSession(next); void complete(next); return;
        }
        if (data.status === 'denied' || data.status === 'error') {
          setSession({ ...session, status: data.status, userCode: undefined, verificationUri: undefined });
          setError(data.status === 'denied' ? 'Grok 授权被拒绝，可重新开始。' : `Grok 授权未完成：${data.error ?? '协议或网络错误'}`); return;
        }
        if (data.status !== 'pending') throw new Error('Grok 授权状态异常，请刷新后重新开始。');
        timer = setTimeout(poll, grokPollInterval(data));
      } catch (cause) {
        if (!cancelled) {
          setSession({ ...session, status: 'error', userCode: undefined, verificationUri: undefined });
          setError(cause instanceof Error ? cause.message : 'Grok 授权轮询失败');
        }
      }
    };
    timer = setTimeout(poll, Math.min(grokPollInterval(session), Math.max(0, Date.parse(session.expiresAt) - Date.now())));
    return () => { cancelled = true; controller.abort(); if (timer) clearTimeout(timer); };
  }, [session, unsupported, write.readOnly, complete]);
  const cancel = useCallback(async () => {
    if (!session || completing.current) return;
    setWorking(true);
    try {
      const response = await authFetch(`${GROK_ADMIN_API}/device/${encodeURIComponent(session.sessionId)}`, { method: 'DELETE' });
      if (!response.ok && response.status !== 404) throw new Error('取消授权未确认，请刷新后检查状态。');
      if (mounted.current) { setSession(null); setError(null); }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : '取消授权未完成'); }
    finally { if (mounted.current) setWorking(false); }
  }, [session]);
  const startAuthorization = useCallback(async (credentialRef?: string) => {
    if (write.readOnly || unsupported || completing.current) return;
    setWorking(true); setError(null);
    try {
      const response = await authFetch(`${GROK_ADMIN_API}/device/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentialRef ? { credentialRef } : {}) });
      const data = await readSubscriptionJson<GrokDeviceSession>(response);
      if (!response.ok || !validGrokSession(data)) throw new Error(data.error ?? 'Grok 授权响应无效或包含不受信的验证链接');
      if (mounted.current) setSession(data);
      const verificationUri = safeGrokVerificationUri(data.verificationUri);
      if (verificationUri) window.open(verificationUri, '_blank', 'noopener,noreferrer');
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Grok 授权启动失败'); }
    finally { if (mounted.current) setWorking(false); }
  }, [unsupported, write.readOnly]);
  const mutate = useCallback(async (path: string, method: 'PUT' | 'DELETE', body?: Record<string, unknown>) => {
    if (write.readOnly || unsupported) return;
    setWorking(true); setError(null);
    try {
      const confirmation = write.confirmMutation(); if (confirmation === null) return;
      const response = await write.mutationFetch(`${GROK_ADMIN_API}${path}`, method === 'DELETE'
        ? { method, headers: write.deleteHeaders(confirmation) }
        : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, ...write.bodyMetadata(confirmation) }) });
      const data = await readSubscriptionJson<GrokSubscriptionState>(response);
      if (!response.ok || !validGrokState(data)) throw new Error(data.error ?? `HTTP ${response.status}`);
      applyState(data);
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Grok 配置修改失败'); }
    finally { if (mounted.current) setWorking(false); }
  }, [applyState, unsupported, write]);
  const reorder = useCallback(async (from: number, to: number) => {
    const refs = state?.credentials.map((account) => account.id) ?? [];
    if (refs.some((ref) => !ref) || from < 0 || to < 0 || from >= refs.length || to >= refs.length) return;
    const [moved] = refs.splice(from, 1); refs.splice(to, 0, moved);
    await mutate('/credentials/order', 'PUT', { credentialRefs: refs });
  }, [mutate, state]);
  const removeCredential = useCallback(async (account: SubscriptionCredentialState) => {
    if (account.id && window.confirm(`确定删除 Grok 授权账号「${account.email ?? `尾号 ${account.accountIdHint ?? '未知'}`}」吗？`)) {
      await mutate(`/credentials/${encodeURIComponent(account.id)}`, 'DELETE');
    }
  }, [mutate]);
  const disconnect = useCallback(async () => {
    if (window.confirm('确定停用 Grok 订阅并断开全部账号吗？远端撤销未确认时会显示警告。')) await mutate('', 'DELETE');
  }, [mutate]);
  const save = useCallback(() => mutate('', 'PUT', { enabled, quotaCooldownMinutes, oauthClientId }), [enabled, mutate, oauthClientId, quotaCooldownMinutes]);
  return { state, session, loading, working, unsupported, error, enabled, setEnabled, quotaCooldownMinutes, setQuotaCooldownMinutes,
    oauthClientId, setOauthClientId, refresh, complete, cancel, startAuthorization, reorder, removeCredential, disconnect, save,
    readOnly: write.readOnly || unsupported || !state, writePolicy: write.policy, uncertainOperationId: write.uncertainOperationId };
}
''')
put('GrokSubscriptionCard.tsx', '''import type { ReactNode } from 'react';
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
export function GrokSubscriptionCard({ readOnly, children }: { readOnly: boolean; children?: (state: GrokSubscriptionState | null) => ReactNode }) {
  const grok = useGrokSubscription(readOnly);
  const accounts = grok.state?.credentials ?? [];
  const activeSession = grok.session?.status === 'pending' || grok.session?.status === 'authorized_pending_publication';
  const busy = grok.working || activeSession;
  const coldValid = Number.isInteger(grok.quotaCooldownMinutes) && grok.quotaCooldownMinutes >= 1 && grok.quotaCooldownMinutes <= 10_080;
  const clientValid = /^[A-Za-z0-9._-]{1,256}$/.test(grok.oauthClientId);
  const verificationUri = safeGrokVerificationUri(grok.session?.verificationUri);
  const runtime = grok.state?.runtime;
  return <Card id="grok-subscription" className="h-fit">
    <CardHeader className="pb-3"><CardTitle className="flex items-center justify-between gap-3 text-base">
      <span className="flex items-center gap-1.5"><KeyRound className="size-4 text-muted-foreground" />Grok 订阅鉴权</span>
      <Badge variant={accounts.some((account) => account.connected) ? 'secondary' : 'outline'}>
        {grok.unsupported ? '服务端未支持' : accounts.some((account) => account.connected) ? '已连接' : '未连接'}
      </Badge>
    </CardTitle></CardHeader>
    <CardContent className="space-y-4">
      {grok.loading && !grok.state ? <div className="flex h-20 items-center justify-center"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div> : <>
        <p className="text-xs text-muted-foreground">平台级 Grok 订阅账号池，按下方优先级使用。明确额度耗尽或永久授权失效时才切换账号；普通限流不会轮换账号规避限制。工具、审批和会话仍由本平台执行，不回退到 API Key 计费。</p>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1.5 md:col-span-2"><Label htmlFor="grok-endpoint">Endpoint</Label><Input id="grok-endpoint" value={grok.state?.config.endpoint ?? ''} disabled /></div>
          <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" checked={grok.enabled} disabled={grok.readOnly || busy || !accounts.length} onChange={(event) => grok.setEnabled(event.target.checked)} />启用 Grok 订阅 transport</label>
          <div className="space-y-1.5"><Label htmlFor="grok-quota-cooldown">额度耗尽冷却（分钟）</Label>
            <Input id="grok-quota-cooldown" type="number" min={1} max={10_080} value={grok.quotaCooldownMinutes} disabled={grok.readOnly || busy} onChange={(event) => grok.setQuotaCooldownMinutes(Number(event.target.value))} />
            <p className="text-xs text-muted-foreground">冷却期间跳过该账号，到期按原优先级恢复探测。</p>
          </div>
        </div>
        <details className="text-xs"><summary className="cursor-pointer text-muted-foreground">OAuth 客户端设置</summary>
          <div className="mt-2 space-y-1.5"><Label htmlFor="grok-oauth-client">公开 OAuth client ID</Label>
            <Input id="grok-oauth-client" value={grok.oauthClientId} disabled={grok.readOnly || busy} onChange={(event) => grok.setOauthClientId(event.target.value)} />
            <p className="text-muted-foreground">仅填写 xAI 允许用于此部署的公开客户端标识，不是密钥。已登记账号仍使用签发时的 client ID 刷新。</p>
          </div>
        </details>
        <SubscriptionAccounts accounts={accounts} readOnly={grok.readOnly} working={busy} reorder={grok.reorder} startAuthorization={grok.startAuthorization} removeCredential={grok.removeCredential} />
        {runtime && <div className="rounded-md border bg-muted/20 p-3 text-xs">
          <div className="font-medium">当前实例运行状态</div>
          <div className="mt-2 grid gap-1 text-muted-foreground md:grid-cols-2">
            <div>最近请求：{formatTime(runtime.lastRequestAt)}</div><div>最近成功：{formatTime(runtime.lastSuccessAt)}</div>
            <div>OAuth 最近刷新：{formatTime(runtime.oauth.lastRefreshAt)}</div><div>刷新代次：{runtime.oauth.lastRefreshGeneration ?? '未知'}</div>
          </div>
          {runtime.lastError && <p className="mt-2 text-destructive">最近请求错误：{runtime.lastError}</p>}
          {runtime.oauth.lastRefreshError && <p className="mt-1 text-destructive">刷新错误：{runtime.oauth.lastRefreshError}</p>}
          <p className="mt-2 text-muted-foreground">当前采用完整历史 HTTP/SSE。此诊断窗口随实例重启清空；长期用量以平台账本为准。</p>
        </div>}
        {grok.session && <div className="rounded-md border border-primary/30 bg-primary/5 p-3" aria-live="polite">
          <p className="text-sm font-medium">{grok.session.status === 'pending' ? '等待 xAI 授权确认' : grok.session.status === 'authorized_pending_publication' ? '已授权，尚未登记到平台' : grok.session.status === 'expired' ? '授权已过期' : grok.session.status === 'denied' ? '授权被拒绝' : '授权未完成'}</p>
          {grok.session.status === 'pending' && <>
            <p className="mt-2 text-xs text-muted-foreground">在 xAI 页面输入以下一次性授权码：</p>
            <div className="mt-2 font-mono text-2xl font-semibold tracking-[0.25em]">{grok.session.userCode}</div>
            {verificationUri && <a className="mt-3 inline-flex items-center gap-1 text-sm text-primary underline" href={verificationUri} target="_blank" rel="noopener noreferrer"><ExternalLink className="size-3.5" />打开 xAI 授权页面</a>}
            <p className="mt-2 text-xs text-muted-foreground">弹窗被阻止时可点击链接。确认后会自动推进平台登记；刷新页面或服务重启后，未完成授权可能需要重新开始。</p>
          </>}
          <div className="mt-3 flex flex-wrap gap-2">
            {grok.session.status === 'authorized_pending_publication' && <Button size="sm" disabled={grok.readOnly || grok.working} onClick={() => void grok.complete()}><Save className="size-3.5" />继续登记</Button>}
            <Button size="sm" variant="outline" disabled={grok.working} onClick={() => void grok.cancel()}><X className="size-3.5" />{activeSession ? '取消本次授权' : '关闭授权任务'}</Button>
          </div>
        </div>}
        {grok.error && <p role="alert" className="text-sm text-destructive">{grok.error}</p>}
        {grok.writePolicy?.canSave === false && <p className="text-xs text-muted-foreground">{grok.writePolicy.message ?? '当前为只读配置状态'}</p>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={grok.readOnly || busy} onClick={() => void grok.startAuthorization()}>{grok.working ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}添加授权账号</Button>
          <Button size="sm" disabled={grok.readOnly || busy || !coldValid || !clientValid} onClick={() => void grok.save()}><Save className="size-3.5" />保存设置</Button>
          <Button size="sm" variant="ghost" disabled={grok.working} onClick={() => void grok.refresh()}><RefreshCw className="size-3.5" />刷新</Button>
          {accounts.length > 0 && <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" disabled={grok.readOnly || busy} onClick={() => void grok.disconnect()}><Unplug className="size-3.5" />断开全部并撤销</Button>}
        </div>
        {children?.(grok.state)}
      </>}
    </CardContent>
  </Card>;
}
function formatTime(value?: string): string { return value ? new Date(value).toLocaleString() : '尚无'; }
''')
p=root/'index.tsx';s=p.read_text();s='import { GrokSubscriptionCard } from "./GrokSubscriptionCard";\n'+s
needle='<CodexSubscriptionCard readOnly={accountReadOnly} />';assert needle in s
s=s.replace(needle,needle+'\n              <GrokSubscriptionCard readOnly={accountReadOnly} />',1);p.write_text(s)
print('Applied shared Codex/Grok account priority controls and an independent Grok administrator card immediately below Codex')
