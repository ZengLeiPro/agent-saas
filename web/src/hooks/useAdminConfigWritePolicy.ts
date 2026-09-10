import { useCallback, useMemo, useRef, useState } from 'react';
import { parseConfigWritePolicy, type ConfigWritePolicy } from '@agent/shared/configWritePolicy';
import { authFetch } from '@/lib/authFetch';

export interface AdminConfigResponseMetadata {
  revision?: string;
  writePolicy?: ConfigWritePolicy;
}

function newOperationId(): string {
  return crypto.randomUUID();
}

async function assertOperationRetrySafe(operationId: string): Promise<void> {
  const response = await authFetch(`/api/admin/config-operations/${encodeURIComponent(operationId)}`);
  const operation = await response.json().catch(() => ({})) as { state?: string };
  if (response.ok && operation.state && !['not_committed', 'rolled_back'].includes(operation.state)) {
    throw new Error(`${operationId} 状态 ${operation.state}，请刷新`);
  }
}

/** 配置页统一使用服务端策略与 raw revision，不根据域名猜环境。 */
export function useAdminConfigWritePolicy(accountReadOnly: boolean) {
  const [revision, setRevision] = useState('');
  const [policy, setPolicy] = useState<ConfigWritePolicy | null>(null);
  const pendingOperationIdRef = useRef<string | null>(null);

  const acceptMetadata = useCallback((value: AdminConfigResponseMetadata) => {
    if (typeof value.revision === 'string' && value.revision) setRevision(value.revision);
    const next = parseConfigWritePolicy(value.writePolicy);
    setPolicy(next);
  }, []);

  const confirmMutation = useCallback((): string | undefined | null => {
    if (!revision) throw new Error('配置版本尚未加载');
    if (policy?.canSave !== true)
      throw new Error(policy?.message ?? '未取得配置写入策略');
    if (policy.environment !== 'production') return undefined;
    return window.confirm('确认保存生产配置并等待双端生效？')
      ? revision
      : null;
  }, [policy, revision]);

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

  const mutationFetch = useCallback(async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const operationId = pendingOperationIdRef.current;
    try {
      let response: Response;
      try {
        response = await authFetch(input, init);
      } catch (error) {
        if (operationId) {
          try {
            await assertOperationRetrySafe(operationId);
          } catch (statusError) {
            if (statusError instanceof Error && statusError.message.includes(operationId)) throw statusError;
          }
        }
        throw error;
      }
      if (response.status >= 500 && operationId) await assertOperationRetrySafe(operationId);
      return response;
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
