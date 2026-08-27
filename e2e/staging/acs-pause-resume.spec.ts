import { expect, test } from 'playwright/test';
import {
  apiLogin,
  authorizedJson,
  currentSessionId,
  login,
  required,
  sendAgentCase,
} from './helpers';

test('Sandbox Ready 到 Paused 再 Resume 后工作区继续可用', async ({ page, request }) => {
  await login(page);
  await sendAgentCase(
    page,
    'pause-seed',
    `写入 ${required('STAGING_RELEASE_ID')}-pause-proof.txt，内容为 pause-resume-proof。`,
  );
  const sessionId = currentSessionId(page);
  const token = await apiLogin(request);
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
  await authorizedJson(
    request,
    token,
    `/api/admin/runtime-operations/acs/sandboxes/${sandbox!.name}/resume`,
    { method: 'POST', data: {} },
  );
  await sendAgentCase(
    page,
    'pause-resume',
    `读取 ${required('STAGING_RELEASE_ID')}-pause-proof.txt 并核对内容。`,
  );
});
