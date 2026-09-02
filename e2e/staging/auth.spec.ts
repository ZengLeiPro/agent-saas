import { expect, test } from 'playwright/test';
import { apiLogin, login, required } from './helpers';

test('真实登录、Web entry、API 组件 identity 与 WebSocket upgrade', async ({ page, request }) => {
  await login(page);
  const token = await apiLogin();
  const readiness = await request.get(`${required('STAGING_API_URL')}/api/healthz/ready`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(readiness.ok()).toBeTruthy();
  const body = await readiness.json();
  expect(body.release.releaseId).toBe(required('STAGING_RELEASE_ID'));
  expect(body.release.releaseSha).toBe(required('STAGING_API_SOURCE_SHA'));
  const wsProbe = await page.evaluate(async (apiUrl) => {
    const url = new URL('/ws?probe=1', apiUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.onmessage = (event) => resolve(JSON.parse(String(event.data)));
      socket.onerror = () => reject(new Error('WebSocket probe failed'));
    });
  }, required('STAGING_API_URL'));
  expect(wsProbe).toMatchObject({ data: { type: 'pong', probe: true } });
});
