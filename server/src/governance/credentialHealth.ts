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

async function check(url: string, headers: Record<string, string>): Promise<{ healthy: boolean; code: string }> {
  const response = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(10_000) });
  return response.ok
    ? { healthy: true, code: 'UPSTREAM_IDENTITY_VERIFIED' }
    : { healthy: false, code: `UPSTREAM_HTTP_${response.status}` };
}

/** Performs an upstream identity request. Unsupported connectors fail closed. */
export async function validateGovernanceCredentialHealth(
  connectorId: string,
  secret: string,
): Promise<{ healthy: boolean; code: string }> {
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
