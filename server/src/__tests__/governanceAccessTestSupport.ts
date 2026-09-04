export interface GovernanceAccessTestClient {
  request(path: string, init?: RequestInit): Promise<Response>;
}

export async function createAssignmentPreview(
  test: GovernanceAccessTestClient,
  change: Record<string, unknown>,
  query = '',
): Promise<Record<string, unknown>> {
  const response = await test.request(
    `/api/governance/access/assignments/skill/skill-1/preview${query}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(change),
    },
  );
  if (response.status !== 200) throw new Error(`assignment preview failed: ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

export function commitBody(
  change: Record<string, unknown>,
  preview: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...change,
    previewId: preview.previewId,
    baselineDigest: preview.baselineDigest,
    expiresAt: preview.expiresAt,
  };
}
