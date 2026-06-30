import { authFetch } from '@agent/shared';

const PREVIEW_TOKEN_TTL_MS = 50 * 60 * 1000; // 50 minutes

let cachedToken: { token: string; owner?: string; root?: boolean; fetchedAt: number } | null = null;

export async function getPreviewToken(owner?: string, root?: boolean): Promise<string> {
  if (
    cachedToken &&
    cachedToken.owner === owner &&
    cachedToken.root === root &&
    Date.now() - cachedToken.fetchedAt < PREVIEW_TOKEN_TTL_MS
  ) {
    return cachedToken.token;
  }

  const body: Record<string, unknown> = {};
  if (owner) body.owner = owner;
  if (root) body.root = true;

  const res = await authFetch('/api/file/preview-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`加载失败: ${res.status}`);
  const data = await res.json() as { token: string };
  cachedToken = { token: data.token, owner, root, fetchedAt: Date.now() };
  return data.token;
}

export function clearPreviewTokenCache(): void {
  cachedToken = null;
}
