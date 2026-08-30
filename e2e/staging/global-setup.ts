import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright/test';

const authStateId = process.env.GITHUB_RUN_ID?.trim() || 'local';

export const stagingStorageStatePath = join(
  process.env.RUNNER_TEMP?.trim() || tmpdir(),
  `agent-saas-staging-auth-${authStateId}.json`,
);

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for real Staging E2E`);
  return value;
}

export default async function globalSetup(): Promise<void> {
  const apiUrl = required('STAGING_API_URL');
  const webUrl = required('STAGING_WEB_URL');
  const response = await fetch(`${apiUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: required('STAGING_E2E_USERNAME'),
      password: required('STAGING_E2E_PASSWORD'),
    }),
  });
  if (!response.ok) throw new Error(`Staging global login returned ${response.status}`);
  const body = (await response.json()) as { token?: unknown };
  if (typeof body.token !== 'string' || !body.token)
    throw new Error('Staging global login did not return a token');

  await writeFile(
    stagingStorageStatePath,
    JSON.stringify({
      cookies: [],
      origins: [
        {
          origin: new URL(webUrl).origin,
          localStorage: [{ name: 'agentChat.authToken', value: body.token }],
        },
      ],
    }),
    { mode: 0o600 },
  );

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ storageState: stagingStorageStatePath });
    const page = await context.newPage();
    await page.goto(webUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.getByRole('textbox', { name: '消息输入' }).waitFor({
      state: 'visible',
      timeout: 30_000,
    });
  } finally {
    await browser.close();
  }
}
