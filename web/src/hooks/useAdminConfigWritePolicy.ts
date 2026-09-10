import { useCallback, useMemo, useState } from 'react';
import { parseConfigWritePolicy, type ConfigWritePolicy } from '@agent/shared/configWritePolicy';

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
    (confirmation?: string) => ({
      expectedRevision: revision,
      ...(confirmation ? { productionConfirmation: confirmation } : {}),
      operationId: newOperationId(),
    }),
    [revision],
  );

  const deleteHeaders = useCallback(
    (confirmation?: string): Record<string, string> => ({
      'X-Config-Revision': revision,
      'X-Config-Operation-Id': newOperationId(),
      ...(confirmation ? { 'X-Production-Confirmation': confirmation } : {}),
    }),
    [revision],
  );

  return useMemo(
    () => ({
      revision,
      policy,
      readOnly: accountReadOnly || policy?.canSave !== true,
      acceptMetadata,
      confirmMutation,
      bodyMetadata,
      deleteHeaders,
    }),
    [
      acceptMetadata,
      accountReadOnly,
      bodyMetadata,
      confirmMutation,
      deleteHeaders,
      policy,
      revision,
    ],
  );
}
