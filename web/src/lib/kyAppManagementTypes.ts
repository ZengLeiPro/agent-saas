import type { Manifest } from '@kaiyan/ky-app-contract';
import type { SystemDefinition } from './kyAppManagementApi';

export interface SystemVersion {
  digest: string;
  manifest: Manifest;
  status: string;
  reviewStatus: 'not_required' | 'pending' | 'approved';
  reviewReasons: string[];
  createdBy: string;
  allowedActions?: string[];
}
export interface SystemDetail {
  definition: SystemDefinition;
  versions: SystemVersion[];
  metrics: {
    installationCount: number;
    enabledInstallationCount: number;
    unhealthyInstallationCount: number;
    capabilityCount: number;
    externalWriteCapabilityCount: number;
  };
  allowedActions?: string[];
}
export interface OnboardRequest {
  tenantId: string;
  tenantName: string;
  adminName: string;
  adminPhone: string;
  techContactPhone: string;
  systemId: string;
  installationId: string;
  baseUrl: string;
  origin: string;
  grantCredits: number;
  manifest: Manifest;
  members: Array<{
    row: number;
    name: string;
    phone: string;
    departmentPath: string;
    employeeNo?: string;
  }>;
  diagnostic: { readOnlyCapabilityId: string; readOnlyInput: Record<string, unknown> };
  suggestedPrompts?: string[];
}
export interface OnboardExecution {
  executionId: string;
  tenantId: string;
  systemId: string;
  installationId: string;
  request: OnboardRequest;
  requestDigest: string;
  status: 'running' | 'waiting_external' | 'completed' | 'failed';
  currentStep: string;
  steps: Array<{ id: string; status: string; code?: string; detail?: Record<string, unknown> }>;
  result: Record<string, unknown>;
  lastErrorCode: string | null;
}
export interface OnboardResponse {
  execution: OnboardExecution;
  claim?: { path: string; credentialId: string; ticketExpiresAt: string; ackDeadlineAt: string };
}
export interface CredentialTicket {
  credentialId: string;
  keyVersion: string;
  ticket: string;
  ticketExpiresAt: string;
  ackDeadlineAt: string;
  expiresAt: string;
}
export interface CredentialMetadata {
  credentialId: string;
  status: string;
  expiresAt: string;
  ackedAt: string | null;
  revokedAt: string | null;
}
export interface InstallationManagement {
  installation: {
    installationId: string;
    tenantId: string;
    systemId: string;
    baseUrl: string;
    origin: string;
    techContactUserId: string;
    status: string;
    registeredDigest: string | null;
    domainVerifiedAt: string | null;
  };
  definition: { name: string; status: string; publishedDigest: string | null } | null;
  manifest: Manifest | null;
  credentialSummary?: CredentialMetadata[];
  assignmentSummary?: { configured: boolean; ruleCount: number };
  upgrade?: {
    currentDigest: string | null;
    publishedDigest: string | null;
    observedDigest: string | null;
    canSwitch: boolean;
  };
  allowedActions?: string[];
}
