/**
 * 场景直达 deep link 的待消费信箱 —— 与 Web `useScenarioDeepLink` 同语义：
 * 参数只消费一次。
 *
 * Web 靠 module 级 flag + 从 URL 上删参来保证「消费即清」；原生端拿到的是
 * 一次性的 `agent-saas://...` URL，这里用同一套语义：
 * - 同一条 URL 只接受一次（冷启动 `getInitialURL` 与热态 `url` 事件可能重复投递）；
 * - `consume()` 取走后即清空，无论调用方是否真的命中场景库。
 *
 * 沿用 `PendingSharedFilesContext` 的「桥接层只投递、消费方在会话页」结构，
 * 但这里没有跨组件订阅需求，因此是 module 级而非 Context。
 */
import type { ScenarioDeepLinkParams, ScenarioDeepLinkTarget } from '@agent/shared';
import { parseScenarioDeepLink } from '@agent/shared';

let pending: ScenarioDeepLinkTarget | null = null;
let lastAcceptedUrl: string | null = null;

/**
 * 投递一条 deep link；返回本次新接受的目标（重复 URL 或无场景参数时返回 null）。
 */
export function publishScenarioDeepLink(
  url: string,
  params: ScenarioDeepLinkParams,
): ScenarioDeepLinkTarget | null {
  if (url === lastAcceptedUrl) return null;
  const target = parseScenarioDeepLink(params);
  if (!target) return null;
  lastAcceptedUrl = url;
  pending = target;
  return target;
}

/** 取走待消费目标；取走即清空。 */
export function consumeScenarioDeepLink(): ScenarioDeepLinkTarget | null {
  const current = pending;
  pending = null;
  return current;
}

/** 测试与账号切换用：清空信箱与去重标记。 */
export function resetScenarioDeepLinkInbox(): void {
  pending = null;
  lastAcceptedUrl = null;
}
