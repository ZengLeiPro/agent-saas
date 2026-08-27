import { test } from 'playwright/test';
import {
  apiLogin,
  assertAcsToolEvidence,
  currentSessionId,
  login,
  restartStagingService,
  sendAgentCase,
} from './helpers';

test('ACS Orchestrator 重启后同一会话 Sandbox 工作区仍可读回', async ({ page, request }) => {
  await login(page);
  await sendAgentCase(
    page,
    'acs-restart-seed',
    '使用 Shell 把 acs-restart-proof 写入 acs-restart-proof.txt，再使用 Read 核对文件内容。',
  );
  await restartStagingService('agent-saas-acs-orchestrator-staging.service');
  const expectedContent = 'acs-restart-proof';
  await sendAgentCase(
    page,
    'acs-restart-readback',
    `使用 Read 读取 acs-restart-proof.txt；只有内容严格等于 ${expectedContent} 才报告成功。`,
  );
  const token = await apiLogin(request);
  await assertAcsToolEvidence(request, token, currentSessionId(page), ['Read'], expectedContent);
});
