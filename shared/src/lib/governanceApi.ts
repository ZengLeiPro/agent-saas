import { z } from 'zod';
import type { AccessDecision, EffectiveResourceView, ExecutionReadiness } from '../types/governance';
import {
  accessDecisionSchema,
  assertGovernanceUiSafe,
  effectiveResourceViewSchema,
  executionReadinessSchema,
  parseGovernanceDto,
} from '../types/governance';
import { authFetch } from './authFetch';
import { parseJsonResponse } from './parseJsonResponse';

const ACCESS_BASE = '/api/governance/access';
const RESOURCE_BASE = '/api/governance/resources';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

type QueryValue = string | number | boolean | null | undefined;
export type GovernanceCommand = Record<string, unknown>;

export class GovernanceApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GovernanceApiError';
  }
}

function withQuery(path: string, query?: Record<string, QueryValue>): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const suffix = params.toString();
  return suffix ? `${path}?${suffix}` : path;
}

function body(method: string, value?: unknown): RequestInit {
  return {
    method,
    ...(value === undefined ? {} : { headers: JSON_HEADERS, body: JSON.stringify(value) }),
  };
}

function isSuccessCode(code: unknown): boolean {
  return code === 0 || code === 200 || code === '0' || code === '200'
    || code === 'OK' || code === 'SUCCESS';
}

function backendError(value: unknown): { code: string; message: string } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (record.code === undefined) return undefined;
  const code = String(record.code);
  if (isSuccessCode(record.code)) return undefined;
  const message = typeof record.message === 'string'
    ? record.message
    : typeof record.error === 'string' ? record.error : code;
  return { code, message };
}

function unwrapEnvelope(value: unknown): unknown {
  const error = backendError(value);
  if (error) throw new GovernanceApiError(error.code, error.message);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const successCode = isSuccessCode(record.code);
    if (successCode && Object.prototype.hasOwnProperty.call(record, 'data')) return record.data;
  }
  return value;
}

async function request<T = unknown>(
  path: string,
  init?: RequestInit,
  schema?: z.ZodType<T>,
): Promise<T> {
  const response = await authFetch(path, init);
  const errorCopy = !response.ok ? response.clone() : undefined;
  let raw: unknown;
  try {
    raw = await parseJsonResponse(response, '治理');
  } catch (cause) {
    if (errorCopy) {
      const errorBody = await errorCopy.json().catch(() => undefined) as unknown;
      const coded = backendError(errorBody);
      if (coded) throw new GovernanceApiError(coded.code, coded.message, response.status);
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new GovernanceApiError(`HTTP_${response.status}`, message, response.status);
  }

  const payload = unwrapEnvelope(raw);
  try {
    if (schema) return parseGovernanceDto(schema, payload);
    assertGovernanceUiSafe(payload);
    return payload as T;
  } catch (cause) {
    if (cause instanceof GovernanceApiError) throw cause;
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new GovernanceApiError('INVALID_GOVERNANCE_RESPONSE', message, response.status);
  }
}

const id = encodeURIComponent;
const tenant = (tenantId?: string) => ({ tenantId });

/** Existing /api/governance/access endpoints. Raw records remain fail-closed and UI-safe. */
export const governanceAccessApi = {
  getProjection: <T = unknown>(projectionId: string) =>
    request<T>(`${ACCESS_BASE}/projections/${id(projectionId)}`),
  listMemberships: <T = unknown>(tenantId?: string) =>
    request<T>(withQuery(`${ACCESS_BASE}/memberships`, tenant(tenantId))),
  previewMembership: <T = unknown>(userId: string, command: GovernanceCommand, tenantId?: string) =>
    request<T>(withQuery(`${ACCESS_BASE}/memberships/${id(userId)}/preview`, tenant(tenantId)), body('POST', command)),
  updateMembership: <T = unknown>(userId: string, command: GovernanceCommand, tenantId?: string) =>
    request<T>(withQuery(`${ACCESS_BASE}/memberships/${id(userId)}`, tenant(tenantId)), body('PATCH', command)),
  listPlatformAdmins: <T = unknown>() => request<T>(`${ACCESS_BASE}/platform-admins`),
  updatePlatformAdmin: <T = unknown>(userId: string, command: GovernanceCommand) =>
    request<T>(`${ACCESS_BASE}/platform-admins/${id(userId)}`, body('PATCH', command)),
  listAuditEvents: <T = unknown>(query?: { tenantId?: string; before?: string; limit?: number }) =>
    request<T>(withQuery(`${ACCESS_BASE}/audit-events`, query)),
  getEntitlements: <T = unknown>(tenantId?: string) =>
    request<T>(withQuery(`${ACCESS_BASE}/entitlements`, tenant(tenantId))),
  updateEntitlements: <T = unknown>(command: GovernanceCommand, tenantId?: string) =>
    request<T>(withQuery(`${ACCESS_BASE}/entitlements`, tenant(tenantId)), body('PATCH', command)),
  updateEntitlementScope: <T = unknown>(resourceType: string, command: GovernanceCommand, tenantId?: string) =>
    request<T>(withQuery(`${ACCESS_BASE}/entitlement-scopes/${id(resourceType)}`, tenant(tenantId)), body('PUT', command)),
  updatePolicy: <T = unknown>(policyKey: string, command: GovernanceCommand, tenantId?: string) =>
    request<T>(withQuery(`${ACCESS_BASE}/policies/${id(policyKey)}`, tenant(tenantId)), body('PUT', command)),
  getAssignment: <T = unknown>(resourceType: string, resourceId: string, tenantId?: string) =>
    request<T>(withQuery(`${ACCESS_BASE}/assignments/${id(resourceType)}/${id(resourceId)}`, tenant(tenantId))),
  updateAssignment: <T = unknown>(resourceType: string, resourceId: string, command: GovernanceCommand, tenantId?: string) =>
    request<T>(withQuery(`${ACCESS_BASE}/assignments/${id(resourceType)}/${id(resourceId)}`, tenant(tenantId)), body('PUT', command)),
  listContentGrants: <T = unknown>(query?: Record<string, QueryValue>) =>
    request<T>(withQuery(`${ACCESS_BASE}/content-grants`, query)),
  createContentGrant: <T = unknown>(command: GovernanceCommand) =>
    request<T>(`${ACCESS_BASE}/content-grants`, body('POST', command)),
  revokeContentGrant: <T = unknown>(grantId: string, command: GovernanceCommand = {}) =>
    request<T>(`${ACCESS_BASE}/content-grants/${id(grantId)}/revoke`, body('POST', command)),
  listPreferences: <T = unknown>() => request<T>(`${ACCESS_BASE}/preferences`),
  updatePreference: <T = unknown>(command: GovernanceCommand) =>
    request<T>(`${ACCESS_BASE}/preferences`, body('PUT', command)),
};

/** Existing /api/governance/resources endpoints. */
export const governanceResourcesApi = {
  getAgent: <T = unknown>(agentId: string, tenantId?: string) =>
    request<T>(withQuery(`${RESOURCE_BASE}/agents/${id(agentId)}`, tenant(tenantId))),
  getSkill: <T = unknown>(skillId: string) => request<T>(`${RESOURCE_BASE}/skills/${id(skillId)}`),
  listConnectors: <T = unknown>() => request<T>(`${RESOURCE_BASE}/connectors`),
  listCredentials: <T = unknown>(tenantId?: string) =>
    request<T>(withQuery(`${RESOURCE_BASE}/credentials`, tenant(tenantId))),
  getEnvironmentProvider: <T = unknown>(providerId: string) =>
    request<T>(`${RESOURCE_BASE}/environment/providers/${id(providerId)}`),
  getEnvironmentTemplate: <T = unknown>(templateId: string) =>
    request<T>(`${RESOURCE_BASE}/environment/templates/${id(templateId)}`),
  createAgent: <T = unknown>(command: GovernanceCommand) => request<T>(`${RESOURCE_BASE}/agents`, body('POST', command)),
  publishAgentVersion: <T = unknown>(agentId: string, command: GovernanceCommand) =>
    request<T>(`${RESOURCE_BASE}/agents/${id(agentId)}/versions`, body('POST', command)),
  updateAgentStatus: <T = unknown>(agentId: string, command: GovernanceCommand) =>
    request<T>(`${RESOURCE_BASE}/agents/${id(agentId)}/status`, body('PATCH', command)),
  archiveAgent: <T = unknown>(agentId: string, command: GovernanceCommand) =>
    request<T>(`${RESOURCE_BASE}/agents/${id(agentId)}/archive`, body('POST', command)),
  createSkill: <T = unknown>(command: GovernanceCommand) => request<T>(`${RESOURCE_BASE}/skills`, body('POST', command)),
  publishSkillVersion: <T = unknown>(skillId: string, command: GovernanceCommand) =>
    request<T>(`${RESOURCE_BASE}/skills/${id(skillId)}/versions`, body('POST', command)),
  createSkillCandidate: <T = unknown>(skillId: string, command: GovernanceCommand) =>
    request<T>(`${RESOURCE_BASE}/skills/${id(skillId)}/candidates`, body('POST', command)),
  submitSkillCandidate: <T = unknown>(candidateId: string, command: GovernanceCommand) =>
    request<T>(`${RESOURCE_BASE}/skill-candidates/${id(candidateId)}/submit`, body('POST', command)),
  reviewSkillCandidate: <T = unknown>(candidateId: string, command: GovernanceCommand) =>
    request<T>(`${RESOURCE_BASE}/skill-candidates/${id(candidateId)}/review`, body('POST', command)),
  publishSkillCandidate: <T = unknown>(candidateId: string, command: GovernanceCommand) =>
    request<T>(`${RESOURCE_BASE}/skill-candidates/${id(candidateId)}/publish`, body('POST', command)),
  publishConnectorVersion: <T = unknown>(connectorId: string, command: GovernanceCommand) =>
    request<T>(`${RESOURCE_BASE}/connectors/${id(connectorId)}/versions`, body('POST', command)),
  updateConnectorStatus: <T = unknown>(connectorId: string, command: GovernanceCommand) =>
    request<T>(`${RESOURCE_BASE}/connectors/${id(connectorId)}/status`, body('PATCH', command)),
  createCredential: <T = unknown>(command: GovernanceCommand) =>
    request<T>(`${RESOURCE_BASE}/credentials`, body('POST', command)),
  updateCredentialStatus: <T = unknown>(credentialId: string, command: GovernanceCommand, tenantId?: string) =>
    request<T>(withQuery(`${RESOURCE_BASE}/credentials/${id(credentialId)}/status`, tenant(tenantId)), body('PATCH', command)),
  updateEnvironmentProvider: <T = unknown>(providerId: string, command: GovernanceCommand) =>
    request<T>(`${RESOURCE_BASE}/environment/providers/${id(providerId)}`, body('PUT', command)),
  publishEnvironmentTemplate: <T = unknown>(templateId: string, command: GovernanceCommand) =>
    request<T>(`${RESOURCE_BASE}/environment/templates/${id(templateId)}/versions`, body('POST', command)),
  retireEnvironmentTemplate: <T = unknown>(templateId: string, command: GovernanceCommand) =>
    request<T>(`${RESOURCE_BASE}/environment/templates/${id(templateId)}/retire`, body('POST', command)),
  getChangeJob: <T = unknown>(jobId: string, tenantId?: string) =>
    request<T>(withQuery(`${RESOURCE_BASE}/change-jobs/${id(jobId)}`, tenant(tenantId))),
  previewResourceRetirement: <T = unknown>(targetType: string, targetId: string, tenantId?: string) =>
    request<T>(withQuery(`${RESOURCE_BASE}/previews/resource-retirement`, { targetType, targetId, tenantId })),
  previewCredentialChange: <T = unknown>(credentialId: string, action: 'suspend' | 'revoke', tenantId?: string) =>
    request<T>(withQuery(`${RESOURCE_BASE}/previews/credentials/${id(credentialId)}`, { action, tenantId })),
  startUserOffboarding: <T = unknown>(command: GovernanceCommand) =>
    request<T>(`${RESOURCE_BASE}/change-jobs/user-offboarding`, body('POST', command)),
  startTenantDelete: <T = unknown>(command: GovernanceCommand) =>
    request<T>(`${RESOURCE_BASE}/change-jobs/tenant-delete`, body('POST', command)),
  startResourceRetirement: <T = unknown>(command: GovernanceCommand) =>
    request<T>(`${RESOURCE_BASE}/change-jobs/resource-retire`, body('POST', command)),
  startCredentialRevoke: <T = unknown>(command: GovernanceCommand) =>
    request<T>(`${RESOURCE_BASE}/change-jobs/credential-revoke`, body('POST', command)),
};

/** Planned authoritative endpoints. These never infer an allow result locally. */
export async function evaluateAccess(command: GovernanceCommand): Promise<EffectiveResourceView[]> {
  return request('/api/access/evaluate', body('POST', command), z.array(effectiveResourceViewSchema));
}

export async function fetchAccessDecision(decisionId: string): Promise<AccessDecision> {
  return request(`/api/access/decisions/${id(decisionId)}`, undefined, accessDecisionSchema);
}

export async function preflightExecution(command: GovernanceCommand): Promise<ExecutionReadiness> {
  return request('/api/execution/preflight', body('POST', command), executionReadinessSchema);
}

export async function fetchEffectiveResources(domains: string[] = []): Promise<EffectiveResourceView[]> {
  const path = withQuery('/api/me/effective-resources', {
    domains: domains.length ? domains.join(',') : undefined,
  });
  return request(path, undefined, z.array(effectiveResourceViewSchema));
}
