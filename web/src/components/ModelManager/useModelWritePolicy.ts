import { useCallback } from 'react';
import {
  getConfigWritePolicy,
  PRODUCTION_CONFIG_PUBLISH_REQUIRED,
} from '@agent/shared/configWritePolicy';
import { useAdminConfigWritePolicy } from '@/hooks/useAdminConfigWritePolicy';

const UNKNOWN_POLICY = '尚未取得服务端配置写入策略，暂不可修改。请刷新后重试。';
const PRODUCTION_NOTICE =
  '生产环境未提供模型在线发布能力，请走受控运维流程。';

/** UI capability is read from this endpoint, never inferred from hostname or NODE_ENV. */
export function useModelWritePolicy(accountReadOnly: boolean) {
  const common = useAdminConfigWritePolicy(accountReadOnly);
  const acceptMetadata = common.acceptMetadata;
  const policy = common.policy;
  const acceptPolicy = useCallback((value: unknown) => {
    acceptMetadata({ writePolicy: value as never });
  }, [acceptMetadata]);
  const acceptResponse = useCallback((value: { revision?: string; writePolicy?: unknown }) => {
    acceptMetadata(value as never);
  }, [acceptMetadata]);
  const acceptFailure = useCallback((value: { code?: string }) => {
    if (value.code === PRODUCTION_CONFIG_PUBLISH_REQUIRED) {
      // Preserve the local draft; only withdraw permission after an authoritative denial.
      acceptMetadata({ writePolicy: getConfigWritePolicy('production') });
    }
  }, [acceptMetadata]);
  const readOnly = common.readOnly;
  const notice = accountReadOnly
    ? '当前账号只有查看权限，不能保存模型配置。'
    : !policy
      ? UNKNOWN_POLICY
      : !policy.canSave
        ? (policy.message || PRODUCTION_NOTICE)
        : policy.environment === 'production'
          ? '当前为生产环境；保存仅修改当前环境。'
          : policy.environment === 'staging'
            ? '当前为测试环境；保存仅修改当前环境。'
            : null;
  const assertWritable = useCallback(() => {
    if (readOnly) throw new Error(notice ?? UNKNOWN_POLICY);
  }, [notice, readOnly]);
  const confirmationFor = useCallback((revision: string): string | undefined | null => {
    if (policy?.environment !== 'production') return undefined;
    return window.confirm('确认保存生产模型配置并等待双端生效？') ? revision : null;
  }, [policy]);
  return {
    readOnly, acceptPolicy, acceptResponse, acceptFailure, assertWritable, notice, confirmationFor,
    bodyMetadata: common.bodyMetadata, mutationFetch: common.mutationFetch,
  };
}
