/**
 * 会话页侧的场景直达消费 —— 对齐 Web `useScenarioDeepLink` 的预填行为。
 *
 * 语义与 Web 一致：
 * - 参数只消费一次（信箱取走即清），命中与否都不再重放；
 * - `?scenario=` 命中 legacy 场景库时把起手指令预填进输入框（不自动发送）；
 * - `?workflow=` 属于 v3 能力中心的 intent，原生端暂无落地页，只消费不落地。
 */
import { useEffect, useRef } from 'react';
import type { ScenarioItem } from '@agent/shared';
import { buildScenarioPrompt, sanitizeScenario } from '@agent/shared';
import { consumeScenarioDeepLink } from '../lib/scenarioDeepLinkInbox';
import { useScenarioLibrary } from './useScenarioLibrary';

export function useScenarioDeepLink(
  onPrefill: (prompt: string, scenario: ScenarioItem) => void,
): void {
  const { library } = useScenarioLibrary();
  const onPrefillRef = useRef(onPrefill);
  onPrefillRef.current = onPrefill;

  useEffect(() => {
    if (!library) return;
    const target = consumeScenarioDeepLink();
    if (!target || target.kind !== 'scenario') return;
    const matched = library.scenarios.find((scenario) => scenario.id === target.id);
    if (!matched) return;
    const safe = sanitizeScenario({ ...matched }).scenario as ScenarioItem;
    onPrefillRef.current(buildScenarioPrompt(safe), safe);
  }, [library]);
}
