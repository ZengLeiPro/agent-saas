import { createHash } from 'node:crypto';
import { expect, test } from 'playwright/test';
import {
  apiLogin,
  authorizedJson,
  login,
  restartStagingService,
  sendAgentCase,
} from './helpers';

type ArtifactMetadata = {
  artifactId?: string;
  uri?: string;
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string;
  metadata?: { fileName?: string };
};

type ArtifactReadUrl = {
  url?: string;
  expiresAt?: string;
  direct?: boolean;
};

test('平台管理员可下载自己会话生成的 Excel，API 重启后同一签名地址仍可读', async ({ page, request }) => {
  await login(page);
  await sendAgentCase(
    page,
    'artifact',
    '生成一个包含 staging-artifact-proof 的 Excel（.xlsx）制品，并在最终回答说明文件名。',
    request,
  );
  const sessionId = new URL(page.url()).pathname.split('/').filter(Boolean).at(-1);
  expect(sessionId).toBeTruthy();
  const token = await apiLogin();
  const listing = (await authorizedJson(
    request,
    token,
    `/api/sessions/${encodeURIComponent(sessionId!)}/artifacts`,
  )) as { artifacts?: ArtifactMetadata[] };
  expect(Array.isArray(listing.artifacts)).toBeTruthy();
  const artifact = listing.artifacts?.find((candidate) => candidate.metadata?.fileName?.endsWith('.xlsx'));
  expect(artifact).toMatchObject({
    artifactId: expect.any(String),
    uri: expect.stringMatching(/^local:\/\//u),
    mimeType: expect.stringContaining('spreadsheet'),
    sizeBytes: expect.any(Number),
    sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
  });

  const signed = (await authorizedJson(
    request,
    token,
    `/api/artifacts/${encodeURIComponent(artifact!.artifactId!)}/read-url?download=true`,
  )) as ArtifactReadUrl;
  expect(signed).toMatchObject({
    url: expect.any(String),
    expiresAt: expect.any(String),
    direct: false,
  });
  const beforeRestart = await request.get(signed.url!);
  expect(beforeRestart.status()).toBe(200);
  expect(beforeRestart.headers()['content-disposition']).toMatch(/^attachment;/u);
  const beforeBody = await beforeRestart.body();
  expect(beforeBody.byteLength).toBe(artifact!.sizeBytes);
  expect(createHash('sha256').update(beforeBody).digest('hex')).toBe(artifact!.sha256);

  await restartStagingService('agent-saas-server-staging.service');
  await expect.poll(async () => (await request.get(signed.url!)).status(), { timeout: 60_000 }).toBe(200);
  const afterRestart = await request.get(signed.url!);
  const afterBody = await afterRestart.body();
  expect(afterBody.byteLength).toBe(artifact!.sizeBytes);
  expect(createHash('sha256').update(afterBody).digest('hex')).toBe(artifact!.sha256);
});
