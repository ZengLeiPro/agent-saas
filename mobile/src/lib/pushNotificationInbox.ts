/**
 * 通知点击落地目标的待消费信箱 —— 与 `scenarioDeepLinkInbox` 同一套语义：
 * 只消费一次、登录后才消费。
 *
 * 冷启动（`getLastPushResponseAsync`）与热态监听可能投递同一条通知，
 * 因此按通知 identifier 去重；未登录时目标先留在信箱里，登录完成后由桥接层取走，
 * 避免把未登录用户直接推进会话页。
 */
import type { PushNotificationTarget } from '@agent/shared';
import { parsePushNotificationTarget } from '@agent/shared';

let pending: PushNotificationTarget | null = null;
let lastAcceptedIdentifier: string | null = null;

/**
 * 投递一条通知点击；返回本次新接受的目标（重复 identifier 或路径不可识别时返回 null）。
 */
export function publishPushNotificationTarget(
  identifier: string,
  data: unknown,
): PushNotificationTarget | null {
  if (identifier === lastAcceptedIdentifier) return null;
  const target = parsePushNotificationTarget(data);
  if (!target) return null;
  lastAcceptedIdentifier = identifier;
  pending = target;
  return target;
}

/** 取走待消费目标；取走即清空。 */
export function consumePushNotificationTarget(): PushNotificationTarget | null {
  const current = pending;
  pending = null;
  return current;
}

/** 测试与账号切换用：清空信箱与去重标记。 */
export function resetPushNotificationInbox(): void {
  pending = null;
  lastAcceptedIdentifier = null;
}
