/**
 * 壳侧安全事件与 `agent.open` 审计上报（规范 §5.4）。
 *
 * 服务端落点是 `server/src/kyapp/routes/shellEvents.ts`；事件闭集两端同名。
 * 一律 fire-and-forget：审计是观测，不能反过来把界面卡住（服务端也因此在
 * 审计不可用时回 503 让这里静默吞掉）。
 */
import { authFetch } from '@/lib/authFetch';

/** 与 `server/src/kyapp/routes/shellEvents.ts` 的 `KY_APP_SHELL_EVENTS` 一一对应。 */
export const APP_SHELL_EVENTS = [
  'handshake_failed',
  'attestation_failed',
  'path_rejected',
  'link_blocked',
  'message_rejected',
  'agent_open',
] as const;
export type AppShellEvent = (typeof APP_SHELL_EVENTS)[number];

const SHELL_EVENTS_PATH = '/api/app-contract/v1/shell-events';
/** 与服务端 zod 上限一致；超了服务端会 400，白跑一趟。 */
const DETAIL_MAX_LENGTH = 200;
const REASON_MAX_LENGTH = 64;

export interface AppShellEventInput {
  event: AppShellEvent;
  installationId: string;
  reason?: string;
  detail?: string;
}

/**
 * 上报一条壳侧事件。永不抛错、永不 await 出可见延迟。
 * 返回 Promise 只为测试能等它落地。
 */
export async function reportAppShellEvent(input: AppShellEventInput): Promise<void> {
  if (!input.installationId) return;
  const body: Record<string, string> = {
    event: input.event,
    installationId: input.installationId,
  };
  if (input.reason) body.reason = input.reason.slice(0, REASON_MAX_LENGTH);
  if (input.detail) body.detail = input.detail.slice(0, DETAIL_MAX_LENGTH);
  try {
    await authFetch(SHELL_EVENTS_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    /* 审计不可达不影响用户；服务端 503 同理 */
  }
}
