import { expect, test } from 'playwright/test';
import { apiLogin, authorizedJson, required } from './helpers';

test('Taskboard Integration receipt 在 Staging 可权威读回', async ({ request }) => {
  const token = await apiLogin(request);
  const taskId = required('STAGING_E2E_INTEGRATION_TASK_ID');
  const sources = (await authorizedJson(
    request,
    token,
    `/api/taskboard/tasks/${encodeURIComponent(taskId)}/integration-sources`,
  )) as unknown[];
  expect(Array.isArray(sources)).toBeTruthy();
  expect(sources.length).toBeGreaterThan(0);
});
