import { createSign } from 'node:crypto';

import type { AppConfig } from './config.js';
import type {
  GithubAppInstallationToken,
  GithubAppInstallationTokenProvider,
  RuntimeIsolationAttestationEvidence,
  RuntimeIsolationAttestationProvider,
} from './runtimeContracts.js';
import { requestAcsOrchestrator } from '../routes/runtimeOperationsAdmin.js';
import type { SecretVault } from '../security/secretVault.js';

const ACS_PROBE_TIMEOUT_MS = 90_000;
const GITHUB_API_VERSION = '2022-11-28';
const MAX_GITHUB_TOKEN_TTL_MS = 65 * 60_000;

type GithubAppConfig = NonNullable<NonNullable<AppConfig['integrationV3ControlPlane']>['githubApp']>;

export function createAcsRuntimeIsolationAttestationProvider(input: {
  config: AppConfig;
  secretVault?: SecretVault;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): RuntimeIsolationAttestationProvider {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;
  return {
    async attest(): Promise<RuntimeIsolationAttestationEvidence | undefined> {
      const result = await requestAcsOrchestrator({
        config: input.config,
        secretVault: input.secretVault,
        fetchImpl,
        timeoutMs: ACS_PROBE_TIMEOUT_MS,
        path: '/network-policy/probe',
        method: 'POST',
        body: {},
      });
      if (result.status !== 200) return undefined;
      return parseAcsAttestation(result.body, now());
    },
  };
}

export function createGithubAppInstallationTokenProvider(input: {
  appId: number;
  privateKey: () => Promise<string>;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): GithubAppInstallationTokenProvider {
  if (!Number.isSafeInteger(input.appId) || input.appId <= 0) throw new Error('GitHub App ID must be a positive safe integer');
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;
  const apiBaseUrl = (input.apiBaseUrl ?? 'https://api.github.com').replace(/\/$/, '');
  return {
    async getInstallationToken(request): Promise<GithubAppInstallationToken | undefined> {
      if (!Number.isSafeInteger(request.installationId) || request.installationId <= 0) return undefined;
      if ('repositoryId' in request && (!Number.isSafeInteger(request.repositoryId) || request.repositoryId <= 0)) return undefined;
      if ('repositoryOwner' in request && (!validGithubName(request.repositoryOwner) || !validGithubName(request.repositoryName))) return undefined;
      const privateKey = await input.privateKey();
      if (!privateKey.trim()) return undefined;
      const jwt = signGithubAppJwt(input.appId, privateKey, now());
      const response = await fetchImpl(`${apiBaseUrl}/app/installations/${request.installationId}/access_tokens`, {
        method: 'POST',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${jwt}`,
          'content-type': 'application/json',
          'user-agent': 'agent-saas-integration-v3',
          'x-github-api-version': GITHUB_API_VERSION,
        },
        body: JSON.stringify('repositoryId' in request
          ? { repository_ids: [request.repositoryId] }
          : { repositories: [request.repositoryName] }),
      });
      const body: unknown = await response.json().catch(() => undefined);
      if (response.status !== 201) return undefined;
      return parseGithubInstallationToken(body, request, now());
    },
  };
}

export function resolveProductionIntegrationV3Adapters(input: {
  config: AppConfig;
  secretVault: SecretVault;
  runtimeIsolationAttestationProvider?: RuntimeIsolationAttestationProvider;
  githubAppInstallationTokenProvider?: GithubAppInstallationTokenProvider;
  fetchImpl?: typeof fetch;
}): {
  runtimeIsolationAttestationProvider?: RuntimeIsolationAttestationProvider;
  githubAppInstallationTokenProvider?: GithubAppInstallationTokenProvider;
} {
  if (input.config.integrationV3ControlPlane?.enabled !== true) return {};
  const runtimeIsolationAttestationProvider = input.runtimeIsolationAttestationProvider
    ?? createAcsRuntimeIsolationAttestationProvider({ config: input.config, secretVault: input.secretVault, fetchImpl: input.fetchImpl });
  const app = input.config.integrationV3ControlPlane.githubTokenMode === 'github_app'
    ? input.config.integrationV3ControlPlane.githubApp
    : undefined;
  const githubAppInstallationTokenProvider = input.config.integrationV3ControlPlane.githubTokenMode === 'github_app'
    ? input.githubAppInstallationTokenProvider ?? (app ? createGithubAppInstallationTokenProvider({
      appId: app.appId,
      privateKey: () => input.secretVault.getSecret(app.privateKeyRef, {
        actor: 'system', userId: '__system__', scopes: ['secret:github_app:read'],
      }),
      ...(app.apiBaseUrl ? { apiBaseUrl: app.apiBaseUrl } : {}),
      fetchImpl: input.fetchImpl,
    }) : undefined)
    : undefined;
  return { runtimeIsolationAttestationProvider, githubAppInstallationTokenProvider };
}

function parseAcsAttestation(body: unknown, nowMs: number): RuntimeIsolationAttestationEvidence | undefined {
  if (!isRecord(body) || body.status !== 'ok' || !isRecord(body.networkPolicy)) return undefined;
  const policy = body.networkPolicy;
  if (!isRecord(policy.effectivePolicy) || !isRecord(policy.probe)) return undefined;
  const effective = policy.effectivePolicy;
  const checks = isRecord(policy.probe.checks) ? policy.probe.checks : undefined;
  if (effective.enforcement !== 'enforced' || effective.privateEgressBlocked !== true
    || effective.metadataBlocked !== true || effective.dnsRebindingProtected !== true || !checks) return undefined;
  if (!blockedProbe(checks.privateApi) || !blockedProbe(checks.metadata) || !blockedProbe(checks.dnsRebinding)) return undefined;
  if (typeof effective.probeSandboxName !== 'string' || !/^as-[a-z0-9-]{1,60}$/.test(effective.probeSandboxName)
    || typeof effective.checkedAt !== 'string') return undefined;
  const issuedAtMs = Date.parse(effective.checkedAt);
  if (!Number.isFinite(issuedAtMs) || issuedAtMs > nowMs + 30_000 || nowMs - issuedAtMs > ACS_PROBE_TIMEOUT_MS + 30_000) return undefined;
  return {
    runtimeAdapterId: 'acs-orchestrator/network-policy-probe',
    isolationBoundaryId: `acs-sandbox/${effective.probeSandboxName}`,
    issuedAt: effective.checkedAt,
  };
}

function blockedProbe(value: unknown): boolean {
  return isRecord(value) && (
    (typeof value.exitCode === 'number' && Number.isInteger(value.exitCode) && value.exitCode !== 0)
    || (value.exitCode === null && typeof value.signal === 'string' && value.signal.length > 0)
  );
}

function signGithubAppJwt(appId: number, privateKey: string, nowMs: number): string {
  const issuedAt = Math.floor(nowMs / 1000) - 30;
  const header = encodeJson({ alg: 'RS256', typ: 'JWT' });
  const payload = encodeJson({ iat: issuedAt, exp: issuedAt + 9 * 60, iss: String(appId) });
  const signingInput = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(privateKey).toString('base64url')}`;
}

function parseGithubInstallationToken(
  body: unknown,
  request: ({ repositoryId: number } | { repositoryOwner: string; repositoryName: string }) & { installationId: number },
  nowMs: number,
): GithubAppInstallationToken | undefined {
  if (!isRecord(body) || typeof body.token !== 'string' || body.token.length < 20
    || typeof body.expires_at !== 'string' || body.repository_selection !== 'selected'
    || !Array.isArray(body.repositories) || body.repositories.length !== 1) return undefined;
  const expiresAtMs = Date.parse(body.expires_at);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs + 60_000 || expiresAtMs > nowMs + MAX_GITHUB_TOKEN_TTL_MS) return undefined;
  const repository = body.repositories[0];
  if (!isRecord(repository) || !Number.isSafeInteger(repository.id) || repository.id <= 0) return undefined;
  if ('repositoryId' in request && repository.id !== request.repositoryId) return undefined;
  if ('repositoryOwner' in request && (typeof repository.full_name !== 'string'
    || repository.full_name.toLowerCase() !== `${request.repositoryOwner}/${request.repositoryName}`.toLowerCase())) return undefined;
  return {
    token: body.token,
    repositoryId: repository.id,
    installationId: request.installationId,
    expiresAt: body.expires_at,
  };
}

function validGithubName(value: string): boolean {
  return /^[A-Za-z0-9_.-]{1,100}$/.test(value);
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
