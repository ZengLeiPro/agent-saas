import { expect, type APIRequestContext, type Page } from 'playwright/test';
import { randomUUID } from 'node:crypto';

export function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for real Staging E2E`);
  return value;
}

export async function login(page: Page): Promise<string> {
  await page.goto('/');
  await page.getByLabel('账号').fill(required('STAGING_E2E_USERNAME'));
  await page.getByLabel('密码').fill(required('STAGING_E2E_PASSWORD'));
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByPlaceholder('输入消息...')).toBeVisible();
  const token = await page.evaluate(() => localStorage.getItem('agentChat.authToken'));
  if (!token) throw new Error('Login did not persist an authentication token');
  return token;
}

export async function apiLogin(request: APIRequestContext): Promise<string> {
  const response = await request.post(`${required('STAGING_API_URL')}/api/auth/login`, {
    data: {
      username: required('STAGING_E2E_USERNAME'),
      password: required('STAGING_E2E_PASSWORD'),
    },
  });
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  if (!body.token) throw new Error('Staging API login did not return a token');
  return body.token;
}

export function marker(caseName: string): string {
  return `STAGING_E2E_OK:${required('STAGING_RELEASE_ID')}:${caseName}:${randomUUID()}`;
}

export async function sendAgentCase(
  page: Page,
  caseName: string,
  instructions: string,
): Promise<string> {
  const expected = marker(caseName);
  const input = page.getByPlaceholder('输入消息...');
  await input.fill(`${instructions}\n全部完成后，在最终回答中原样输出：${expected}`);
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('.prose-chat').filter({ hasText: expected }).last()).toBeVisible({
    timeout: 8 * 60_000,
  });
  return expected;
}

export async function authorizedJson(
  request: APIRequestContext,
  token: string,
  path: string,
  options: { method?: 'GET' | 'POST' | 'DELETE'; data?: object } = {},
): Promise<unknown> {
  const response = await request.fetch(`${required('STAGING_API_URL')}${path}`, {
    method: options.method ?? 'GET',
    headers: { authorization: `Bearer ${token}` },
    ...(options.data ? { data: options.data } : {}),
  });
  expect(response.ok(), `${path} returned ${response.status()}`).toBeTruthy();
  return response.json();
}
