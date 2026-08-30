import { test } from 'playwright/test';
import { login, sendAgentCase } from './helpers';

test('浏览器消息经过持久化 Worker 流式回写', async ({ page, request }) => {
  await login(page);
  await sendAgentCase(page, 'chat-stream', '请分三段流式回答，并说明当前会话已经由运行时处理。', request);
});
