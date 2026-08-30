import { expect, test } from 'playwright/test';
import {
  apiLogin,
  authorizedJson,
  currentSessionId,
  login,
  required,
  sendAgentCase,
  assertAcsToolEvidence,
  waitForSessionRun,
} from './helpers';

async function waitForSandboxPhase(
  request: Parameters<typeof authorizedJson>[0],
  token: string,
  sandboxName: string,
  expectedPhase: 'Paused' | 'Running',
): Promise<void> {
  await expect
    .poll(
      async () => {
        const detail = (await authorizedJson(
          request,
          token,
          `/api/admin/runtime-operations/acs/sandboxes/${encodeURIComponent(sandboxName)}`,
        )) as { phase?: string; sandbox?: { status?: { phase?: string } } };
        return detail.phase ?? detail.sandbox?.status?.phase;
      },
      { timeout: 2 * 60_000 },
    )
    .toBe(expectedPhase);
}

test('Sandbox Running 到 Paused 再 Resume 后有权威 Read trace', async ({ page, request }) => {
  await login(page);
  await sendAgentCase(
    page,
    'pause-seed',
    `必须使用 Write 工具写入 ${required('STAGING_RELEASE_ID')}-pause-proof.txt，内容为 pause-resume-proof。`,
    request,
  );
  const sessionId = currentSessionId(page);
  const token = await apiLogin();
  const seedRun = await waitForSessionRun(request, token, sessionId);
  const inventory = (await authorizedJson(
    request,
    token,
    '/api/admin/runtime-operations/acs/sandboxes',
  )) as {
    sandboxes?: Array<{ name: string; status?: string; sessionId?: string }>;
    items?: Array<{ name: string; status?: string; sessionId?: string }>;
  };
  const sandboxes = inventory.sandboxes ?? inventory.items ?? [];
  const matches = sandboxes.filter((item) => item.sessionId === sessionId);
  expect(matches).toHaveLength(1);
  const sandbox = matches[0];
  expect(sandbox?.name).toBeTruthy();
  await authorizedJson(
    request,
    token,
    `/api/admin/runtime-operations/acs/sandboxes/${sandbox!.name}/pause`,
    { method: 'POST', data: {} },
  );
  await waitForSandboxPhase(request, token, sandbox!.name, 'Paused');
  await authorizedJson(
    request,
    token,
    `/api/admin/runtime-operations/acs/sandboxes/${sandbox!.name}/resume`,
    { method: 'POST', data: {} },
  );
  await waitForSandboxPhase(request, token, sandbox!.name, 'Running');
  await sendAgentCase(
    page,
    'pause-resume',
    `恢复后必须使用 Read 工具读取 ${required('STAGING_RELEASE_ID')}-pause-proof.txt，并核对内容为 pause-resume-proof。`,
    request,
  );
  await assertAcsToolEvidence(
    request,
    token,
    sessionId,
    ['Read'],
    'pause-resume-proof',
    new Set([seedRun.runId]),
  );
});
