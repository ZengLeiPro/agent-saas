import { expect, test } from 'playwright/test';
import {
  apiLogin,
  currentSessionId,
  login,
  readRunTrace,
  sendAgentCase,
  waitForSessionRun,
} from './helpers';

test('Shell 超时被记录为失败且 Agent 可完成受控恢复', async ({ page, request }) => {
  await login(page);
  await sendAgentCase(
    page,
    'timeout-recovery',
    '使用 Shell 执行 sleep 30，并明确把 timeoutMs 设为 1000；确认工具发生超时后停止重试，再报告已受控恢复。',
  );
  const token = await apiLogin();
  const run = await waitForSessionRun(request, token, currentSessionId(page));
  const events = await readRunTrace(request, token, run.runId);
  expect(
    events.some(
      (event) =>
        event.type === 'tool_result' &&
        event.toolName === 'Shell' &&
        event.isError === true &&
        /timed out|超时/iu.test(String(event.content ?? '')),
    ),
  ).toBeTruthy();
});
