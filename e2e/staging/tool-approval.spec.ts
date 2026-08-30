import { expect, test } from 'playwright/test';
import { login, marker, messageInput } from './helpers';

test('高风险工具在批准前不执行，批准后结果回写', async ({ page }) => {
  await login(page);
  const expected = marker('tool-approval');
  await messageInput(page).fill(
    `请使用 Shell 执行 printf ${expected}，不得绕过工具批准；执行成功后在最终回答原样输出 ${expected}`,
  );
  await page.getByRole('button', { name: '发送消息' }).click();
  const approve = page.getByRole('button', { name: /允许|批准/u }).first();
  await expect(approve).toBeVisible();
  await expect(page.locator('.prose-chat').filter({ hasText: expected })).toHaveCount(0);
  await approve.click();
  await expect(page.locator('.prose-chat').filter({ hasText: expected }).last()).toBeVisible({
    timeout: 8 * 60_000,
  });
});
