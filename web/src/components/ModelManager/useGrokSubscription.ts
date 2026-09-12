import { useCallback, useEffect, useRef, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import { useAdminConfigWritePolicy } from '@/hooks/useAdminConfigWritePolicy';
import {
  GROK_ADMIN_API,
  grokPollInterval,
  readSubscriptionJson,
  safeGrokVerificationUri,
  validGrokSession,
  validGrokState,
} from './grokSubscriptionClient';
import type {
  GrokDeviceSession,
  GrokSubscriptionState,
  SubscriptionCredentialState,
} from './subscriptionTypes';
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
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const applyState = useCallback(
    (next: GrokSubscriptionState) => {
      if (!mounted.current) return;
      acceptMetadata(next);
      setState(next);
      setUnsupported(false);
      setEnabled(next.config.enabled);
      setQuotaCooldownMinutes(next.config.quotaCooldownMinutes ?? 60);
      setOauthClientId(next.config.oauthClientId ?? '');
      setError(next.warning ?? null);
    },
    [acceptMetadata],
  );
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await authFetch(GROK_ADMIN_API);
      if ([404, 501].includes(response.status)) {
        acceptMetadata({});
        setUnsupported(true);
        setState(null);
        setError('当前服务端尚未支持 Grok 订阅，请完成服务端升级后刷新。');
        return;
      }
      const data = await readSubscriptionJson<GrokSubscriptionState>(response);
      if (!response.ok || !validGrokState(data))
        throw new Error(data.error ?? `HTTP ${response.status}`);
      applyState(data);
    } catch (cause) {
      if (mounted.current) {
        acceptMetadata({});
        setError(cause instanceof Error ? cause.message : 'Grok 状态读取失败');
      }
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [acceptMetadata, applyState]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (
      unsupported ||
      working ||
      !state?.credentials.some(
        (account) => account.availability && account.availability !== 'available',
      )
    )
      return;
    const timer = setInterval(() => {
      void refresh();
    }, 30_000);
    return () => clearInterval(timer);
  }, [refresh, state, unsupported, working]);
  const complete = useCallback(
    async (current: GrokDeviceSession | null = session) => {
      if (!current || current.status !== 'authorized_pending_publication' || completing.current)
        return;
      completing.current = true;
      setWorking(true);
      setError(null);
      try {
        if (write.readOnly) throw new Error('当前配置不可写；外部授权已完成，尚未登记到平台。');
        const confirmation = write.confirmMutation();
        if (confirmation === null) {
          setError('外部授权已完成，尚未登记到平台；可在授权有效期内继续登记。');
          return;
        }
        const response = await write.mutationFetch(
          `${GROK_ADMIN_API}/device/${encodeURIComponent(current.sessionId)}/complete`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(write.bodyMetadata(confirmation)),
          },
        );
        const data = await readSubscriptionJson<GrokSubscriptionState & { status: string }>(
          response,
        );
        if (!response.ok || data.status !== 'applied' || !validGrokState(data))
          throw new Error(data.error ?? `HTTP ${response.status}`);
        applyState(data);
        if (mounted.current) setSession(null);
      } catch (cause) {
        if (mounted.current)
          setError(cause instanceof Error ? cause.message : 'Grok 登记未完成，请先刷新确认结果');
      } finally {
        completing.current = false;
        if (mounted.current) setWorking(false);
      }
    },
    [applyState, session, write],
  );
  useEffect(() => {
    if (!session || session.status !== 'pending' || unsupported || write.readOnly) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const poll = async () => {
      if (Date.now() >= Date.parse(session.expiresAt)) {
        setSession({
          ...session,
          status: 'expired',
          userCode: undefined,
          verificationUri: undefined,
        });
        setError('Grok 授权码已过期，请重新发起授权。');
        return;
      }
      try {
        const response = await authFetch(
          `${GROK_ADMIN_API}/device/${encodeURIComponent(session.sessionId)}/poll`,
          { method: 'POST', signal: controller.signal },
        );
        const data = await readSubscriptionJson<GrokDeviceSession>(response);
        if (cancelled) return;
        if (response.status === 410 || data.status === 'expired') {
          setSession({
            ...session,
            status: 'expired',
            userCode: undefined,
            verificationUri: undefined,
          });
          setError('Grok 授权码已过期，请重新发起授权。');
          return;
        }
        if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
        if (data.status === 'authorized_pending_publication') {
          const next = {
            ...session,
            status: data.status,
            userCode: undefined,
            verificationUri: undefined,
          };
          setSession(next);
          void complete(next);
          return;
        }
        if (data.status === 'denied' || data.status === 'error') {
          setSession({
            ...session,
            status: data.status,
            userCode: undefined,
            verificationUri: undefined,
          });
          setError(
            data.status === 'denied'
              ? 'Grok 授权被拒绝，可重新开始。'
              : `Grok 授权未完成：${data.error ?? '协议或网络错误'}`,
          );
          return;
        }
        if (data.status !== 'pending') throw new Error('Grok 授权状态异常，请刷新后重新开始。');
        timer = setTimeout(poll, grokPollInterval(data));
      } catch (cause) {
        if (!cancelled) {
          setSession({
            ...session,
            status: 'error',
            userCode: undefined,
            verificationUri: undefined,
          });
          setError(cause instanceof Error ? cause.message : 'Grok 授权轮询失败');
        }
      }
    };
    timer = setTimeout(
      poll,
      Math.min(grokPollInterval(session), Math.max(0, Date.parse(session.expiresAt) - Date.now())),
    );
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [session, unsupported, write.readOnly, complete]);
  const cancel = useCallback(async () => {
    if (!session || completing.current) return;
    setWorking(true);
    try {
      const response = await authFetch(
        `${GROK_ADMIN_API}/device/${encodeURIComponent(session.sessionId)}`,
        { method: 'DELETE' },
      );
      if (!response.ok && response.status !== 404)
        throw new Error('取消授权未确认，请刷新后检查状态。');
      if (mounted.current) {
        setSession(null);
        setError(null);
      }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : '取消授权未完成');
    } finally {
      if (mounted.current) setWorking(false);
    }
  }, [session]);
  const startAuthorization = useCallback(
    async (credentialRef?: string) => {
      if (write.readOnly || unsupported || completing.current) return;
      setWorking(true);
      setError(null);
      try {
        const response = await authFetch(`${GROK_ADMIN_API}/device/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(credentialRef ? { credentialRef } : {}),
        });
        const data = await readSubscriptionJson<GrokDeviceSession>(response);
        if (!response.ok || !validGrokSession(data))
          throw new Error(data.error ?? 'Grok 授权响应无效或包含不受信的验证链接');
        if (mounted.current) setSession(data);
        const verificationUri = safeGrokVerificationUri(data.verificationUri);
        if (verificationUri) window.open(verificationUri, '_blank', 'noopener,noreferrer');
      } catch (cause) {
        if (mounted.current) setError(cause instanceof Error ? cause.message : 'Grok 授权启动失败');
      } finally {
        if (mounted.current) setWorking(false);
      }
    },
    [unsupported, write.readOnly],
  );
  const mutate = useCallback(
    async (path: string, method: 'PUT' | 'DELETE', body?: Record<string, unknown>) => {
      if (write.readOnly || unsupported) return;
      setWorking(true);
      setError(null);
      try {
        const confirmation = write.confirmMutation();
        if (confirmation === null) return;
        const response = await write.mutationFetch(
          `${GROK_ADMIN_API}${path}`,
          method === 'DELETE'
            ? { method, headers: write.deleteHeaders(confirmation) }
            : {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...body, ...write.bodyMetadata(confirmation) }),
              },
        );
        const data = await readSubscriptionJson<GrokSubscriptionState>(response);
        if (!response.ok || !validGrokState(data))
          throw new Error(data.error ?? `HTTP ${response.status}`);
        applyState(data);
      } catch (cause) {
        if (mounted.current) setError(cause instanceof Error ? cause.message : 'Grok 配置修改失败');
      } finally {
        if (mounted.current) setWorking(false);
      }
    },
    [applyState, unsupported, write],
  );
  const reorder = useCallback(
    async (from: number, to: number) => {
      const refs = state?.credentials.map((account) => account.id) ?? [];
      if (
        refs.some((ref) => !ref) ||
        from < 0 ||
        to < 0 ||
        from >= refs.length ||
        to >= refs.length
      )
        return;
      const [moved] = refs.splice(from, 1);
      refs.splice(to, 0, moved);
      await mutate('/credentials/order', 'PUT', { credentialRefs: refs });
    },
    [mutate, state],
  );
  const removeCredential = useCallback(
    async (account: SubscriptionCredentialState) => {
      if (
        account.id &&
        window.confirm(
          `确定删除 Grok 授权账号「${account.email ?? `尾号 ${account.accountIdHint ?? '未知'}`}」吗？`,
        )
      ) {
        await mutate(`/credentials/${encodeURIComponent(account.id)}`, 'DELETE');
      }
    },
    [mutate],
  );
  const disconnect = useCallback(async () => {
    if (window.confirm('确定停用 Grok 订阅并断开全部账号吗？远端撤销未确认时会显示警告。'))
      await mutate('', 'DELETE');
  }, [mutate]);
  const save = useCallback(
    () => mutate('', 'PUT', { enabled, quotaCooldownMinutes, oauthClientId }),
    [enabled, mutate, oauthClientId, quotaCooldownMinutes],
  );
  return {
    state,
    session,
    loading,
    working,
    unsupported,
    error,
    enabled,
    setEnabled,
    quotaCooldownMinutes,
    setQuotaCooldownMinutes,
    oauthClientId,
    setOauthClientId,
    refresh,
    complete,
    cancel,
    startAuthorization,
    reorder,
    removeCredential,
    disconnect,
    save,
    readOnly: write.readOnly || unsupported || !state,
    writePolicy: write.policy,
    uncertainOperationId: write.uncertainOperationId,
  };
}
