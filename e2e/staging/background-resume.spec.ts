import { test } from 'playwright/test';
import { login, sendAgentCase } from './helpers';

test('后台任务在页面重连后仍回写同一会话', async ({ page, request }) => {
  await login(page);
  await sendAgentCase(
    page,
    'background-start',
    '启动一个后台 Shell 任务，等待两秒后写入 background-proof.txt；确认任务已进入后台后再回复。',
    request,
  );
  await page.reload();
  await sendAgentCase(
    page,
    'background-resume',
    '等待后台任务完成，读取 background-proof.txt 并核对内容。',
    request,
  );
});
