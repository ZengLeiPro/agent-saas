/** Display contract only. The server mutation service remains the write authority. */
export const PRODUCTION_CONFIG_PUBLISH_REQUIRED = 'PRODUCTION_CONFIG_PUBLISH_REQUIRED' as const;
export const PRODUCTION_CONFIG_PUBLISH_MESSAGE =
  '生产配置不能直接在线保存，请通过受控配置发布流程变更';
export type ConfigEnvironment = 'staging' | 'production' | 'development' | 'test';
export type ConfigWritePolicy =
  | { environment: ConfigEnvironment; mode: 'online'; canSave: true }
  | {
      environment: 'production';
      mode: 'controlled-publish-required';
      canSave: false;
      reasonCode: typeof PRODUCTION_CONFIG_PUBLISH_REQUIRED;
      message: string;
    };

/** allowProductionMutation is an INTERNAL publisher option, never an HTTP input. */
export function getConfigWritePolicy(
  environment: ConfigEnvironment,
  allowProductionMutation = false,
): ConfigWritePolicy {
  if (environment === 'production' && !allowProductionMutation) {
    return {
      environment,
      mode: 'controlled-publish-required',
      canSave: false,
      reasonCode: PRODUCTION_CONFIG_PUBLISH_REQUIRED,
      message: PRODUCTION_CONFIG_PUBLISH_MESSAGE,
    };
  }
  return { environment, mode: 'online', canSave: true };
}

/** A missing/unknown/inconsistent capability is NOT permission to write. */
export function parseConfigWritePolicy(value: unknown): ConfigWritePolicy | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const policy = value as Record<string, unknown>;
  const environment = policy.environment;
  if (
    environment !== 'staging' &&
    environment !== 'production' &&
    environment !== 'development' &&
    environment !== 'test'
  )
    return null;
  if (policy.mode === 'online' && policy.canSave === true && policy.reasonCode === undefined) {
    return { environment, mode: 'online', canSave: true };
  }
  if (
    environment === 'production' &&
    policy.mode === 'controlled-publish-required' &&
    policy.canSave === false &&
    policy.reasonCode === PRODUCTION_CONFIG_PUBLISH_REQUIRED &&
    typeof policy.message === 'string' &&
    policy.message.trim()
  ) {
    return {
      environment,
      mode: 'controlled-publish-required',
      canSave: false,
      reasonCode: PRODUCTION_CONFIG_PUBLISH_REQUIRED,
      message: policy.message,
    };
  }
  return null;
}
