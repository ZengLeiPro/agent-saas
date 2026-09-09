import type { KyAppInstallationRuntimeRecord } from './runtimeStore.js';
import type { KyAppInstallation, KyAppSystemStatus } from '../systems/types.js';

export interface InstallationReadiness {
  overallStatus: 'action_required' | 'ready' | 'degraded' | 'disabled';
  pageStatus: 'not_configured' | 'available' | 'unavailable';
  agentStatus:
    'not_configured' | 'waiting_service' | 'waiting_assignment' | 'ready' | 'degraded' | 'disabled';
  personalAuthorizationMode: 'not_required';
  currentStep: string | null;
  reasonCode: string | null;
  ownerRole: 'platform_admin' | 'organization_admin' | 'technical_contact' | 'member' | null;
  nextAction: string;
  lastCheckedAt: string | null;
}

export function installationReadiness(input: {
  installation: KyAppInstallation;
  definitionStatus: KyAppSystemStatus | null;
  publishedDigest: string | null;
  runtime: KyAppInstallationRuntimeRecord | null;
  assignmentConfigured: boolean;
}): InstallationReadiness {
  const { installation, definitionStatus, publishedDigest, runtime, assignmentConfigured } = input;
  const base = {
    personalAuthorizationMode: 'not_required' as const,
    lastCheckedAt: runtime?.readyCheckedAt ?? runtime?.liveCheckedAt ?? null,
  };
  if (installation.status === 'disabled' || installation.status === 'deleted')
    return {
      ...base,
      overallStatus: 'disabled',
      pageStatus: 'unavailable',
      agentStatus: 'disabled',
      currentStep: null,
      reasonCode: 'installation_disabled',
      ownerRole: 'organization_admin',
      nextAction: '启用业务系统',
    };
  if (definitionStatus !== 'published')
    return {
      ...base,
      overallStatus: 'disabled',
      pageStatus: 'unavailable',
      agentStatus: 'disabled',
      currentStep: null,
      reasonCode: 'system_definition_unavailable',
      ownerRole: 'platform_admin',
      nextAction: '联系平台管理员处理系统状态',
    };
  const onboarding = installation.status === 'pending';
  if (!installation.domainVerifiedAt)
    return {
      ...base,
      overallStatus: 'action_required',
      pageStatus: 'not_configured',
      agentStatus: 'not_configured',
      currentStep: 'domain_verification',
      reasonCode: 'domain_verification_required',
      ownerRole: 'technical_contact',
      nextAction: '验证业务域名',
    };
  if (
    runtime?.liveStatus === 'failed' ||
    runtime?.liveStatus === 'maintenance' ||
    runtime?.readyStatus === 'failed'
  )
    return {
      ...base,
      overallStatus: 'degraded',
      pageStatus: onboarding
        ? 'not_configured'
        : runtime.liveStatus === 'failed' || runtime.liveStatus === 'maintenance'
          ? 'unavailable'
          : 'available',
      agentStatus: 'degraded',
      currentStep: 'service_readiness',
      reasonCode:
        runtime.liveStatus === 'maintenance' ? 'service_maintenance' : 'diagnostic_failed',
      ownerRole: 'technical_contact',
      nextAction: '重新检查服务',
    };
  if (
    !installation.registeredDigest ||
    runtime?.liveStatus !== 'ok' ||
    runtime.readyStatus !== 'ok'
  )
    return {
      ...base,
      overallStatus: 'action_required',
      pageStatus: onboarding ? 'not_configured' : 'available',
      agentStatus: 'waiting_service',
      currentStep: 'service_readiness',
      reasonCode: 'ready_required',
      ownerRole: 'technical_contact',
      nextAction: '继续接入',
    };
  if (
    runtime.manifestDigest !== installation.registeredDigest ||
    installation.registeredDigest !== publishedDigest
  )
    return {
      ...base,
      overallStatus: 'action_required',
      pageStatus: onboarding ? 'not_configured' : 'available',
      agentStatus: 'waiting_service',
      currentStep: 'version_registration',
      reasonCode: 'manifest_digest_mismatch',
      ownerRole: 'platform_admin',
      nextAction: '确认业务版本',
    };
  if (!assignmentConfigured)
    return {
      ...base,
      overallStatus: 'action_required',
      pageStatus: onboarding ? 'not_configured' : 'available',
      agentStatus: 'waiting_assignment',
      currentStep: 'assignment',
      reasonCode: 'assignment_required',
      ownerRole: 'organization_admin',
      nextAction: '配置访问范围',
    };
  if (onboarding)
    return {
      ...base,
      overallStatus: 'action_required',
      pageStatus: 'not_configured',
      agentStatus: 'waiting_service',
      currentStep: 'activation',
      reasonCode: 'activation_required',
      ownerRole: 'organization_admin',
      nextAction: '启用业务系统',
    };
  return {
    ...base,
    overallStatus: 'ready',
    pageStatus: 'available',
    agentStatus: 'ready',
    currentStep: null,
    reasonCode: null,
    ownerRole: null,
    nextAction: '无需处理',
  };
}
