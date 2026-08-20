import { createAliyunValidateCredentials } from '../connectors/aliyun.js';

export interface CredentialHealthResult {
  healthy: boolean;
  code: string;
  metadata?: Record<string, string>;
}

function tokenFromSecret(secret: string): string | null {
  const trimmed = secret.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith('{')) return trimmed;
  try {
    const value = JSON.parse(trimmed) as Record<string, unknown>;
    for (const key of ['accessToken', 'access_token', 'token', 'personalAccessToken']) {
      if (typeof value[key] === 'string' && value[key]) return value[key] as string;
    }
  } catch {
    return null;
  }
  return null;
}

async function check(url: string, headers: Record<string, string>): Promise<CredentialHealthResult> {
  const response = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(10_000) });
  return response.ok
    ? { healthy: true, code: 'UPSTREAM_IDENTITY_VERIFIED' }
    : { healthy: false, code: `UPSTREAM_HTTP_${response.status}` };
}

async function checkAliyun(secret: string): Promise<CredentialHealthResult> {
  try {
    const value = JSON.parse(secret) as Record<string, unknown>;
    const accessKeyId = typeof value.accessKeyId === 'string' ? value.accessKeyId.trim() : '';
    const accessKeySecret = typeof value.accessKeySecret === 'string' ? value.accessKeySecret.trim() : '';
    const regionId = typeof value.regionId === 'string' ? value.regionId.trim() : '';
    if (!accessKeyId || !accessKeySecret || !regionId) return { healthy: false, code: 'CREDENTIAL_SECRET_FORMAT_INVALID' };
    const identity = await createAliyunValidateCredentials()({ accessKeyId, accessKeySecret, regionId });
    return {
      healthy: true,
      code: 'UPSTREAM_IDENTITY_VERIFIED',
      metadata: {
        accountId: identity.accountId,
        ...(identity.arn ? { identityArn: identity.arn } : {}),
        ...(identity.identityType ? { identityType: identity.identityType } : {}),
      },
    };
  } catch {
    return { healthy: false, code: 'UPSTREAM_IDENTITY_CHECK_FAILED' };
  }
}

/** Performs an upstream identity request. Unsupported connectors fail closed. */
export async function validateGovernanceCredentialHealth(
  connectorId: string,
  secret: string,
): Promise<CredentialHealthResult> {
  if (connectorId === 'aliyun') return checkAliyun(secret);
  const token = tokenFromSecret(secret);
  if (!token) return { healthy: false, code: 'CREDENTIAL_SECRET_FORMAT_INVALID' };
  if (connectorId === 'github') {
    return check('https://api.github.com/user', {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'agent-saas-governance-health',
      'x-github-api-version': '2022-11-28',
    });
  }
  if (connectorId === 'notion') {
    return check('https://api.notion.com/v1/users/me', {
      authorization: `Bearer ${token}`,
      'notion-version': '2022-06-28',
    });
  }
  throw new Error(`CONNECTOR_HEALTH_CHECK_UNSUPPORTED:${connectorId}`);
}
