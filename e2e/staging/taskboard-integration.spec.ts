import { expect, test } from 'playwright/test';
import { apiLogin, authorizedJson, required } from './helpers';

test('Taskboard Integration 隔离 fixture 在迁移后可鉴权读回', async ({ request }) => {
  const token = await apiLogin();
  const taskId = required('STAGING_E2E_INTEGRATION_TASK_ID');
  const sources = (await authorizedJson(
    request,
    token,
    `/api/taskboard/tasks/${encodeURIComponent(taskId)}/integration-sources`,
  )) as Array<{
    id?: string;
    integrationTaskId?: string;
    deliveryTaskId?: string;
    repositoryId?: string;
    state?: string;
  }>;
  expect(Array.isArray(sources)).toBeTruthy();
  expect(sources).toHaveLength(1);
  expect(sources[0]).toMatchObject({
    id: 'staging-e2e-integration-source',
    integrationTaskId: taskId,
    deliveryTaskId: 'staging-e2e-integration-delivery',
    repositoryId: 'staging-fixture:none',
    state: 'canceled',
  });
});
