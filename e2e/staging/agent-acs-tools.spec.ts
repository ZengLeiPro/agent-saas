import { test } from 'playwright/test';
import { login, sendAgentCase } from './helpers';

test('真实 Agent 在 ACS Sandbox 完成 Read Write Shell Browser 与流式 Shell', async ({ page }) => {
  await login(page);
  await sendAgentCase(
    page,
    'agent-acs-tools',
    '依次使用 Write 写入 e2e-proof.txt、Read 读回、Shell 和流式 Shell 校验内容，再使用 Browser 打开 https://staging.agent.kaiyan.net 并读取页面标题。任何一步失败都不要输出成功标记。',
  );
});
