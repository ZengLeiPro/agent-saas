import { useCallback, useMemo, useRef, useState } from 'react';
import { parseConfigWritePolicy, type ConfigWritePolicy } from '@agent/shared/configWritePolicy';
import { authFetch } from '@/lib/authFetch';

export interface AdminConfigResponseMetadata {
  revision?: string;
  writePolicy?: ConfigWritePolicy;
}

function newOperationId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `op-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

/** 配置页统一使用服务端策略与 raw revision，不根据域名猜环境。 */
export function useAdminConfigWritePolicy(accountReadOnly: boolean, operationLabel: string) {
  const [revision, setRevision] = useState('');
  const [policy, setPolicy] = useState<ConfigWritePolicy | null>(null);
  const pendingOperationIdRef = useRef<string | null>(null);

  const acceptMetadata = useCallback((value: AdminConfigResponseMetadata) => {
    if (typeof value.revision === 'string' && value.revision) setRevision(value.revision);
    const next = parseConfigWritePolicy(value.writePolicy);
    setPolicy((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
  }, []);

  const confirmMutation = useCallback((): string | undefined | null => {
    if (!revision) throw new Error('配置版本尚未加载，请先刷新');
    if (policy?.canSave !== true)
      throw new Error(policy?.message ?? '尚未取得服务端配置写入策略，暂不可保存');
    if (policy.environment !== 'production') return undefined;
    return window.confirm(
      `当前为生产环境。保存${operationLabel}将修改当前环境，并等待 API 与 Worker 同时生效。确认继续？`,
    )
      ? revision
      : null;
  }, [operationLabel, policy, revision]);

  const bodyMetadata = useCallback(
    (confirmation?: string) => {
      const operationId = newOperationId();
      pendingOperationIdRef.current = operationId;
      return {
      expectedRevision: revision,
      ...(confirmation ? { productionConfirmation: confirmation } : {}),
        operationId,
      };
    },
    [revision],
  );

  const deleteHeaders = useCallback((confirmation?: string): Record<string, string> => {
    const operationId = newOperationId();
    pendingOperationIdRef.current = operationId;
    return {
        'X-Config-Revision': revision,
        'X-Config-Operation-Id': operationId,
        ...(confirmation ? { 'X-Production-Confirmation': confirmation } : {}),
      };
    },
    [revision],
  );

  /** Network/5xx is ambiguous: query the original id once and never synthesize a retry. */
  const mutationFetch = useCallback(async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const operationId = pendingOperationIdRef.current;
    try {
      const response = await authFetch(input, init);
      if (response.status < 500 || !operationId) {
        pendingOperationIdRef.current = null;
        return response;
      }
      const status = await authFetch(`/api/admin/config-operations/${encodeURIComponent(operationId)}`);
      const operation = await status.json().catch(() => ({})) as { state?: string };
      if (status.ok && operation.state && operation.state !== 'not_committed' && operation.state !== 'rolled_back') {
        throw new Error(`配置操作 ${operationId} 当前状态为 ${operation.state}，请刷新读取结果，勿重复提交`);
      }
      pendingOperationIdRef.current = null;
      return response;
    } catch (error) {
      if (operationId) {
        try {
          const status = await authFetch(`/api/admin/config-operations/${encodeURIComponent(operationId)}`);
          const operation = await status.json().catch(() => ({})) as { state?: string };
          if (status.ok && operation.state && operation.state !== 'not_committed' && operation.state !== 'rolled_back') {
            throw new Error(`配置操作 ${operationId} 当前状态为 ${operation.state}，请刷新读取结果，勿重复提交`);
          }
        } catch (statusError) {
          if (statusError instanceof Error && statusError.message.includes(operationId)) throw statusError;
        }
      }
      throw error;
    } finally {
      pendingOperationIdRef.current = null;
    }
  }, []);

  return useMemo(
    () => ({
      revision,
      policy,
      readOnly: accountReadOnly || policy?.canSave !== true,
      acceptMetadata,
      confirmMutation,
      bodyMetadata,
      deleteHeaders,
      mutationFetch,
    }),
    [
      acceptMetadata,
      accountReadOnly,
      bodyMetadata,
      confirmMutation,
      deleteHeaders,
      mutationFetch,
      policy,
      revision,
    ],
  );
}
