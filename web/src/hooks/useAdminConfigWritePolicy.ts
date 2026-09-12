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
  let response: Response;
  try {
    response = await authFetch(`/api/admin/config-operations/${encodeURIComponent(operationId)}`);
  } catch {
    throw new Error(
      `配置操作 ${operationId} 结果不确定：状态查询网络失败。请保留该 ID 并刷新配置，确认前勿重复提交`,
    );
  }
  const operation = (await response.json().catch(() => ({}))) as { state?: string };
  if (!response.ok) {
    throw new Error(
      `配置操作 ${operationId} 结果不确定：状态查询返回 HTTP ${response.status}。请保留该 ID 并刷新配置，确认前勿重复提交`,
    );
  }
  if (operation.state === 'not_committed' || operation.state === 'rolled_back') return;
  const state = operation.state ?? 'unknown';
  throw new Error(
    `配置操作 ${operationId} 状态 ${state}${state === 'applied' || state === 'committed' ? '，可能已生效' : ''}。请刷新配置，确认前勿重复提交`,
  );
}

const AMBIGUOUS_MUTATION_CODES = new Set([
  'CONFIG_MUTATION_COMMITTED',
  'CONFIG_RUNTIME_RESTORE_FAILED',
]);

async function isAmbiguousMutationResponse(response: Response): Promise<boolean> {
  if (response.status < 500) return false;
  const payload = (await response.clone().json().catch(() => ({}))) as { code?: unknown };
  return typeof payload.code === 'string' && AMBIGUOUS_MUTATION_CODES.has(payload.code);
}

/** 配置页统一使用服务端策略与 raw revision，不根据域名猜环境。 */
export function useAdminConfigWritePolicy(accountReadOnly: boolean) {
  const [revision, setRevision] = useState('');
  const [policy, setPolicy] = useState<ConfigWritePolicy | null>(null);
  const [uncertainOperationId, setUncertainOperationId] = useState<string | null>(null);
  const pendingOperationIdRef = useRef<string | null>(null);

  const acceptMetadata = useCallback((value: AdminConfigResponseMetadata) => {
    if (typeof value.revision === 'string' && value.revision) {
      setRevision(value.revision);
      pendingOperationIdRef.current = null;
      setUncertainOperationId(null);
    }
    const next = parseConfigWritePolicy(value.writePolicy);
    setPolicy(next);
  }, []);

  const confirmMutation = useCallback((): string | undefined | null => {
    if (!revision) throw new Error('配置版本尚未加载');
    if (policy?.canSave !== true) throw new Error(policy?.message ?? '未取得配置写入策略');
    if (policy.environment !== 'production') return undefined;
    return window.confirm('确认保存生产配置并等待双端生效？') ? revision : null;
  }, [policy, revision]);

  const bodyMetadata = useCallback(
    (confirmation?: string) => {
      if (pendingOperationIdRef.current) {
        throw new Error(
          `配置操作 ${pendingOperationIdRef.current} 结果尚未确认，请刷新配置后再提交`,
        );
      }
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

  const deleteHeaders = useCallback(
    (confirmation?: string): Record<string, string> => {
      if (pendingOperationIdRef.current) {
        throw new Error(
          `配置操作 ${pendingOperationIdRef.current} 结果尚未确认，请刷新配置后再提交`,
        );
      }
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

  const mutationFetch = useCallback(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const operationId = pendingOperationIdRef.current;
      let preserveOperationId = false;
      try {
        let response: Response;
        try {
          response = await authFetch(input, init);
        } catch (error) {
          if (operationId) {
            try {
              await assertOperationRetrySafe(operationId);
            } catch (statusError) {
              preserveOperationId = true;
              setUncertainOperationId(operationId);
              throw statusError;
            }
          }
          throw error;
        }
        if (operationId && await isAmbiguousMutationResponse(response)) {
          try {
            await assertOperationRetrySafe(operationId);
          } catch (statusError) {
            preserveOperationId = true;
            setUncertainOperationId(operationId);
            throw statusError;
          }
        }
        return response;
      } finally {
        if (!preserveOperationId && pendingOperationIdRef.current === operationId) {
          pendingOperationIdRef.current = null;
          setUncertainOperationId(null);
        }
      }
    },
    [],
  );

  return useMemo(
    () => ({
      revision,
      policy,
      uncertainOperationId,
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
      uncertainOperationId,
    ],
  );
}
