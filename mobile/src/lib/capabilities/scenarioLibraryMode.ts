/**
 * 工作流目录版本选择 —— 对齐 Web `useScenarioLibrary` 的 v3 / legacy 分支。
 *
 * 规则（与 Web 逐条一致）：
 * 1. 只有服务端 `GET /api/scenarios/config` 明确回 `libraryVersion === 'v3'`
 *    才请求 `GET /api/scenarios/v3`；其余一律走 legacy `GET /api/scenarios`；
 * 2. v3 响应必须在客户端再过一次 shared schema（`workflowLibraryPublicV3Schema`），
 *    不通过即视为不可用；
 * 3. v3 不可用时回落 legacy，但必须暴露 `fallbackReason`，
 *    避免把「旧目录仍能显示」误报为 V3 上线成功。
 *
 * 纯函数，无网络与 RN 依赖。
 */

export type ScenarioLibraryMode = 'v3' | 'legacy' | 'legacy-fallback';

export const LEGACY_FALLBACK_REASON = '当前显示兼容目录';

/** 是否应该请求 v3 目录。除显式 'v3' 外一律 false（fail closed 到 legacy）。 */
export function wantsWorkflowLibraryV3(libraryVersion: string | undefined | null): boolean {
  return libraryVersion === 'v3';
}

export interface ScenarioLibraryOutcome {
  mode: ScenarioLibraryMode;
  fallbackReason: string | null;
}

/**
 * 根据「是否想要 v3」与「v3 是否真的拿到了」推导最终模式与回落理由。
 */
export function resolveScenarioLibraryOutcome(input: {
  wantsV3: boolean;
  v3Loaded: boolean;
}): ScenarioLibraryOutcome {
  if (!input.wantsV3) return { mode: 'legacy', fallbackReason: null };
  if (input.v3Loaded) return { mode: 'v3', fallbackReason: null };
  return { mode: 'legacy-fallback', fallbackReason: LEGACY_FALLBACK_REASON };
}

/** 目录接口路径：唯一来源，禁止在调用点拼字符串。 */
export function scenarioLibraryEndpoint(wantsV3: boolean): string {
  return wantsV3 ? '/api/scenarios/v3' : '/api/scenarios';
}
