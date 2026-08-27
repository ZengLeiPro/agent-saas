import { test } from 'playwright/test';
import {
  apiLogin,
  assertAcsToolEvidence,
  currentSessionId,
  login,
  required,
  sendAgentCase,
} from './helpers';

test('真实 Agent 在当前会话 ACS Sandbox 完成 Read Write Shell Browser 与流式 Shell并读回证据', async ({
  page,
  request,
}) => {
  await login(page);
  const proof = `staging-tool-proof-${required('STAGING_RELEASE_ID')}`;
  await sendAgentCase(
    page,
    'agent-acs-tools',
    `依次使用 Write 写入 e2e-proof.txt，文件内容必须为 ${proof}；用 Read 读回；再用 Shell 读回，并执行一个产生多段输出的流式 Shell；最后用 Browser 打开 https://staging-agent.kaiyan.net 并读取页面标题。任何一步失败都不要输出成功标记。`,
  );
  const token = await apiLogin(request);
  await assertAcsToolEvidence(
    request,
    token,
    currentSessionId(page),
    ['Write', 'Read', 'Shell', 'Browser'],
    proof,
  );
});
