import { useCallback, useState } from 'react';
import {
  getConfigWritePolicy,
  parseConfigWritePolicy,
  PRODUCTION_CONFIG_PUBLISH_REQUIRED,
  type ConfigWritePolicy,
} from '@agent/shared/configWritePolicy';

const UNKNOWN_POLICY = '尚未取得服务端配置写入策略，暂不可修改。请刷新后重试。';
const PRODUCTION_NOTICE =
  '生产环境：当前部署尚未提供生产配置在线发布能力，模型配置仅可查看。需通过已验证的受控运维流程变更；重复保存或刷新不会解除此限制。';

/** UI capability is read from this endpoint, never inferred from hostname or NODE_ENV. */
export function useModelWritePolicy(accountReadOnly: boolean) {
  const [policy, setPolicy] = useState<ConfigWritePolicy | null>(null);
  const acceptPolicy = useCallback((value: unknown) => {
    setPolicy(parseConfigWritePolicy(value));
  }, []);
  const acceptFailure = useCallback((value: { code?: string }) => {
    if (value.code === PRODUCTION_CONFIG_PUBLISH_REQUIRED) {
      // Preserve the local draft; only withdraw permission after an authoritative denial.
      setPolicy(getConfigWritePolicy('production'));
    }
  }, []);
  const readOnly = accountReadOnly || policy?.canSave !== true;
  const notice = accountReadOnly
    ? '当前账号只有查看权限，不能保存模型配置。'
    : !policy
      ? UNKNOWN_POLICY
      : !policy.canSave
        ? PRODUCTION_NOTICE
        : policy.environment === 'production'
          ? '当前为生产环境；保存仅修改当前环境。'
          : policy.environment === 'staging'
            ? '当前为测试环境；保存仅修改当前环境。'
            : null;
  const assertWritable = useCallback(() => {
    if (readOnly) throw new Error(notice ?? UNKNOWN_POLICY);
  }, [notice, readOnly]);
  return { readOnly, acceptPolicy, acceptFailure, assertWritable, notice };
}
