import { expect, test } from 'playwright/test';
import { apiLogin, currentSessionId, login, messageInput, waitForSessionRun } from './helpers';

test('取消长运行 Shell 后当前 run 权威终态为 cancelled', async ({ page, request }) => {
  await login(page);
  await messageInput(page).fill('使用 Shell 执行一个等待 120 秒的任务，并等待它完成后再回复。');
  await page.getByRole('button', { name: '发送消息' }).click();
  const stop = page.getByTitle('停止生成');
  await expect(stop).toBeVisible({ timeout: 60_000 });
  await stop.click();
  const token = await apiLogin();
  const run = await waitForSessionRun(request, token, currentSessionId(page), ['cancelled']);
  expect(run.status).toBe('cancelled');
});
