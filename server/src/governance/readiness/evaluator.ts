export type ReadinessBlockerCode =
  | 'RESOURCE_DISABLED'
  | 'RESOURCE_RETIRED'
  | 'CREDENTIAL_NOT_BOUND'
  | 'CREDENTIAL_EXPIRED'
  | 'CREDENTIAL_UNHEALTHY'
  | 'QUOTA_EXHAUSTED'
  | 'RUN_LIMIT_REACHED'
  | 'ENVIRONMENT_UNAVAILABLE'
  | 'PROVIDER_DRAINING'
  | 'PROVIDER_UNHEALTHY'
  | 'MODEL_UNAVAILABLE';

export interface ReadinessBlocker {
  code: ReadinessBlockerCode;
  reason: string;
  retryable: boolean;
  nextAction?: string;
}

export interface ExecutionReadiness {
  ready: boolean;
  accessAllowed: boolean;
  billingAllowed: boolean;
  blockers: ReadinessBlocker[];
  resolvedModelRef?: string;
  resolvedEnvironmentRef?: string;
  resolvedCredentialBindingIds: string[];
  evaluatedAt: string;
}

export interface ReadinessEvaluationInput {
  accessAllowed: boolean;
  resourceEnabled?: boolean;
  resourceRetired?: boolean;
  modelRef?: string;
  modelAvailable?: boolean;
  billingDecision?: { ok: boolean; code?: string; reason?: string };
  runLimitReached?: boolean;
  environment?: { required: boolean; available: boolean; ref?: string };
  providerHealthy?: boolean;
  providerDraining?: boolean;
  credentials?: Array<{ bindingId: string; bound: boolean; expired?: boolean; unhealthy?: boolean }>;
  evaluatedAt?: Date;
}

export class ReadinessEvaluator {
  evaluate(input: ReadinessEvaluationInput): ExecutionReadiness {
    const blockers: ReadinessBlocker[] = [];
    if (input.resourceRetired) blockers.push({ code: 'RESOURCE_RETIRED', reason: '资源已退役', retryable: false });
    else if (input.resourceEnabled === false) blockers.push({ code: 'RESOURCE_DISABLED', reason: '资源已停用', retryable: false });
    if (input.modelRef && input.modelAvailable === false) blockers.push({ code: 'MODEL_UNAVAILABLE', reason: '模型当前不可用', retryable: true });
    if (input.billingDecision?.ok === false) blockers.push({
      code: 'QUOTA_EXHAUSTED',
      reason: input.billingDecision.reason ?? input.billingDecision.code ?? '额度不足',
      retryable: false,
      nextAction: 'review_billing',
    });
    if (input.runLimitReached) blockers.push({ code: 'RUN_LIMIT_REACHED', reason: '并发运行已达上限', retryable: true });
    if (input.environment?.required && !input.environment.available) blockers.push({
      code: 'ENVIRONMENT_UNAVAILABLE',
      reason: '执行环境不可用',
      retryable: true,
      nextAction: 'select_environment',
    });
    if (input.providerDraining) blockers.push({ code: 'PROVIDER_DRAINING', reason: 'Provider 正在排空', retryable: true });
    else if (input.providerHealthy === false) blockers.push({ code: 'PROVIDER_UNHEALTHY', reason: 'Provider 健康检查失败', retryable: true });
    for (const credential of input.credentials ?? []) {
      if (!credential.bound) blockers.push({
        code: 'CREDENTIAL_NOT_BOUND',
        reason: '所需凭据尚未绑定',
        retryable: false,
        nextAction: 'bind_credential',
      });
      else if (credential.expired) blockers.push({
        code: 'CREDENTIAL_EXPIRED',
        reason: '所需凭据已过期',
        retryable: false,
        nextAction: 'reauthorize_credential',
      });
      else if (credential.unhealthy) blockers.push({
        code: 'CREDENTIAL_UNHEALTHY',
        reason: '所需凭据健康检查失败',
        retryable: true,
        nextAction: 'reauthorize_credential',
      });
    }
    return {
      ready: input.accessAllowed && blockers.length === 0,
      accessAllowed: input.accessAllowed,
      billingAllowed: input.billingDecision?.ok !== false,
      blockers,
      ...(input.modelRef ? { resolvedModelRef: input.modelRef } : {}),
      ...(input.environment?.ref ? { resolvedEnvironmentRef: input.environment.ref } : {}),
      resolvedCredentialBindingIds: (input.credentials ?? []).filter(item => item.bound).map(item => item.bindingId),
      evaluatedAt: (input.evaluatedAt ?? new Date()).toISOString(),
    };
  }
}
