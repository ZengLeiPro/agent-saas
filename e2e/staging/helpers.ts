import { expect, type APIRequestContext, type Page } from 'playwright/test';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const RESTARTABLE_STAGING_SERVICES = new Set([
  'agent-saas-runtime-worker-staging.service',
  'agent-saas-acs-orchestrator-staging.service',
]);

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

export async function restartStagingService(service: string): Promise<void> {
  if (!RESTARTABLE_STAGING_SERVICES.has(service))
    throw new Error('Refusing to restart a service outside the Staging E2E allowlist');
  const user = required('STAGING_ECS_USER');
  const host = required('STAGING_ECS_HOST');
  if (!/^[A-Za-z0-9._-]+$/u.test(user) || !/^[A-Za-z0-9.:-]+$/u.test(host))
    throw new Error('Staging SSH identity is invalid');
  await execFileAsync(
    'ssh',
    [
      '-i',
      required('STAGING_SSH_KEY_PATH'),
      '--',
      `${user}@${host}`,
      `sudo systemctl restart ${service}`,
    ],
    { timeout: 3 * 60_000 },
  );
}

export function currentSessionId(page: Page): string {
  const sessionId = new URL(page.url()).pathname.split('/').filter(Boolean).at(-1);
  if (!sessionId) throw new Error('Current page is not bound to a session');
  return sessionId;
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

type TraceEvent = {
  type?: string;
  toolName?: string;
  toolCallId?: string;
  content?: string;
  isError?: boolean;
  status?: string;
  executionTarget?: string;
  toolCalls?: Array<{ id?: string; name?: string }>;
  contentRedacted?: boolean;
};

export async function waitForSessionRun(
  request: APIRequestContext,
  token: string,
  sessionId: string,
  expectedStatuses: string[] = ['completed'],
  excludedRunIds: ReadonlySet<string> = new Set(),
): Promise<{ runId: string; status: string }> {
  let found: { runId: string; status: string } | undefined;
  await expect
    .poll(
      async () => {
        const response = (await authorizedJson(
          request,
          token,
          '/api/admin/runtime/trace/recent-runs?hours=1&limit=200',
        )) as { runs?: Array<{ runId?: string; sessionId?: string; status?: string }> };
        const run = response.runs?.find(
          (item) =>
            item.sessionId === sessionId &&
            expectedStatuses.includes(String(item.status)) &&
            !excludedRunIds.has(String(item.runId)),
        );
        if (run?.runId && run.status) found = { runId: run.runId, status: run.status };
        return found?.status;
      },
      { timeout: 2 * 60_000 },
    )
    .toBeTruthy();
  return found!;
}

export async function readRunTrace(
  request: APIRequestContext,
  token: string,
  runId: string,
): Promise<TraceEvent[]> {
  const trace = (await authorizedJson(
    request,
    token,
    `/api/admin/runtime/trace/runs/${encodeURIComponent(runId)}/events?maxContentLength=65536`,
  )) as { events?: TraceEvent[] };
  expect(Array.isArray(trace.events)).toBeTruthy();
  if (trace.events?.some((event) => event.contentRedacted))
    throw new Error('Staging E2E trace account must be a platform administrator');
  return trace.events ?? [];
}

export async function assertAcsToolEvidence(
  request: APIRequestContext,
  token: string,
  sessionId: string,
  expectedTools: string[],
  expectedContent: string,
  excludedRunIds: ReadonlySet<string> = new Set(),
): Promise<void> {
  const run = await waitForSessionRun(request, token, sessionId, ['completed'], excludedRunIds);
  const events = await readRunTrace(request, token, run.runId);
  const calls = events.flatMap((event) =>
    event.type === 'assistant_tool_calls' ? (event.toolCalls ?? []) : [],
  );
  const results = events.filter((event) => event.type === 'tool_result');
  const audits = events.filter((event) => event.type === 'tool_audit');
  for (const tool of expectedTools) {
    expect(
      calls.some((call) => call.name === tool),
      `${tool} tool call is absent`,
    ).toBeTruthy();
    expect(
      results.some((event) => event.toolName === tool && event.isError !== true),
      `${tool} successful result is absent`,
    ).toBeTruthy();
    if (tool !== 'Browser') {
      expect(
        audits.some(
          (event) =>
            event.toolName === tool &&
            event.status === 'success' &&
            event.executionTarget === 'server-remote',
        ),
        `${tool} was not authoritatively audited on the ACS remote execution target`,
      ).toBeTruthy();
    }
  }
  expect(
    results.some((event) => String(event.content ?? '').includes(expectedContent)),
    'Tool result did not read back the expected file content',
  ).toBeTruthy();
  if (expectedTools.includes('Shell')) {
    expect(
      events.some(
        (event) =>
          (event.type === 'tool_output_delta' || event.type === 'tool_stream_summary') &&
          String(event.content ?? '').includes(expectedContent),
      ),
      'Streaming Shell evidence is absent',
    ).toBeTruthy();
  }
}
