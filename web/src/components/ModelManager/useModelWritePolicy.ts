import { useCallback } from 'react';
import {
  getConfigWritePolicy,
  PRODUCTION_CONFIG_PUBLISH_REQUIRED,
} from '@agent/shared/configWritePolicy';
import { useAdminConfigWritePolicy } from '@/hooks/useAdminConfigWritePolicy';

const UNKNOWN_POLICY = '尚未取得服务端配置写入策略，暂不可修改。请刷新后重试。';
const PRODUCTION_NOTICE =
  '生产环境：当前部署尚未提供生产配置在线发布能力，模型配置仅可查看。需通过已验证的受控运维流程变更；重复保存或刷新不会解除此限制。';

/** UI capability is read from this endpoint, never inferred from hostname or NODE_ENV. */
export function useModelWritePolicy(accountReadOnly: boolean) {
  const common = useAdminConfigWritePolicy(accountReadOnly, '模型配置');
  const policy = common.policy;
  const acceptPolicy = useCallback((value: unknown) => {
    common.acceptMetadata({ writePolicy: value as never });
  }, [common]);
  const acceptFailure = useCallback((value: { code?: string }) => {
    if (value.code === PRODUCTION_CONFIG_PUBLISH_REQUIRED) {
      // Preserve the local draft; only withdraw permission after an authoritative denial.
      common.acceptMetadata({ writePolicy: getConfigWritePolicy('production') });
    }
  }, [common]);
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
    return window.confirm('当前为生产环境。保存将修改当前环境的模型配置，并等待 API 与 Worker 同时生效。确认继续？') ? revision : null;
  }, [policy]);
  return { readOnly, acceptPolicy, acceptFailure, assertWritable, notice, confirmationFor };
}
