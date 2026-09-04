import { parseSessionAutomationCommand } from '@agent/shared';

export interface SessionAutomationChatRejection {
  reasonCode: 'access_denied';
  reason: string;
}

const AUTOMATION_COMMAND = /^\s*\/(?:loop|goal)(?:\s|$)/i;
const DEDICATED_ENDPOINT_REASON = 'Session automation 命令不能通过普通 WebSocket chat 提交；请使用 session automation 命令接口';

export function rejectSessionAutomationChat(
  message: string,
  reject: (rejection: SessionAutomationChatRejection) => void,
): boolean {
  let reason: string | undefined;
  try {
    if (parseSessionAutomationCommand(message) !== null) reason = DEDICATED_ENDPOINT_REASON;
  } catch (error) {
    if (!AUTOMATION_COMMAND.test(message)) throw error;
    reason = `无效的 session automation 命令${error instanceof Error ? `：${error.message}` : ''}`;
  }
  if (!reason) return false;
  reject({ reasonCode: 'access_denied', reason });
  return true;
}
