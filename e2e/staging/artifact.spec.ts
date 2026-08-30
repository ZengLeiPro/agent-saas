import { expect, test } from 'playwright/test';
import { apiLogin, authorizedJson, login, sendAgentCase } from './helpers';

test('Agent 生成的制品可从同一会话持久化读回', async ({ page, request }) => {
  await login(page);
  await sendAgentCase(
    page,
    'artifact',
    '生成一个内容为 staging-artifact-proof 的 Markdown 制品，并在最终回答说明文件名。',
    request,
  );
  const sessionId = new URL(page.url()).pathname.split('/').filter(Boolean).at(-1);
  expect(sessionId).toBeTruthy();
  const token = await apiLogin();
  const artifacts = (await authorizedJson(
    request,
    token,
    `/api/sessions/${encodeURIComponent(sessionId!)}/artifacts`,
  )) as unknown[];
  expect(Array.isArray(artifacts)).toBeTruthy();
  expect(artifacts.length).toBeGreaterThan(0);
});
