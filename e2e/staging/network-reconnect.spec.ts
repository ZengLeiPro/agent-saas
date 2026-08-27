import { test } from 'playwright/test';
import { login, sendAgentCase } from './helpers';

test('浏览器网络中断并恢复后可继续读取同一会话后台结果', async ({ page, context }) => {
  await login(page);
  await sendAgentCase(
    page,
    'network-seed',
    '启动一个后台 Shell，等待五秒后把 network-reconnect-proof 写入 network-proof.txt；确认已经后台启动后回复。',
  );
  await context.setOffline(true);
  await page.waitForTimeout(6_000);
  await context.setOffline(false);
  await page.reload();
  await sendAgentCase(
    page,
    'network-reconnect',
    '读取 network-proof.txt，只有内容严格等于 network-reconnect-proof 才报告成功。',
  );
});
