import { expect, test } from 'playwright/test';
import {
  apiLogin,
  currentSessionId,
  login,
  marker,
  messageInput,
  restartStagingService,
  waitForSessionRun,
} from './helpers';

test('Runtime Worker 重启后活跃 run 由持久化 lease 恢复并完成', async ({ page, request }) => {
  await login(page);
  const expected = marker('runtime-worker-restart');
  const input = messageInput(page);
  await input.fill(
    `使用 Shell 等待 30 秒后写入 worker-restart-proof.txt；读取并核对文件后，在最终回答中原样输出：${expected}`,
  );
  await page.getByRole('button', { name: '发送消息' }).click();
  const token = await apiLogin();
  const sessionId = currentSessionId(page);
  await waitForSessionRun(request, token, sessionId, ['running']);
  await restartStagingService('agent-saas-runtime-worker-staging.service');
  await expect(page.locator('.prose-chat').filter({ hasText: expected }).last()).toBeVisible({
    timeout: 4 * 60_000,
  });
  await waitForSessionRun(request, token, sessionId, ['completed']);
});
