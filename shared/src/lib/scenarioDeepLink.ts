/**
 * 场景直达 deep link 的纯解析 —— 与 Web `useScenarioDeepLink` 同一套参数契约。
 *
 * 支持两种形态：
 * - `?scenario=<id>`：legacy 场景库，命中后把起手指令预填进输入框；
 * - `?workflow=<id>&intent=<intent>`：v3 工作流目录，intent=run 且入口是 chat 时预填，
 *   其余 intent 交给能力中心处理。
 *
 * Web 从 `window.location.search` 取参，移动端从 expo-router 的 URL 参数取，
 * 二者都归一成 `Record<string, string | undefined>` 后交给本函数，保证行为一致。
 */

export type ScenarioDeepLinkIntent = 'view' | 'run' | 'connect' | 'presentation';

export interface ScenarioDeepLinkTarget {
  /** workflow 优先于 scenario，与 Web 取参顺序一致 */
  kind: 'workflow' | 'scenario';
  id: string;
  intent: ScenarioDeepLinkIntent;
}

const INTENTS: readonly ScenarioDeepLinkIntent[] = ['view', 'run', 'connect', 'presentation'];

function normalizeIntent(raw: string | undefined): ScenarioDeepLinkIntent {
  return INTENTS.includes(raw as ScenarioDeepLinkIntent) ? (raw as ScenarioDeepLinkIntent) : 'view';
}

function firstString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value.length > 0 ? value[0] : undefined;
  return value ?? undefined;
}

export type ScenarioDeepLinkParams = Record<string, string | string[] | undefined>;

/**
 * 解析场景直达参数；无 `workflow` / `scenario` 时返回 null（调用方应直接标记已消费）。
 */
export function parseScenarioDeepLink(
  params: ScenarioDeepLinkParams,
): ScenarioDeepLinkTarget | null {
  const workflow = firstString(params.workflow)?.trim();
  if (workflow) {
    return { kind: 'workflow', id: workflow, intent: normalizeIntent(firstString(params.intent)) };
  }
  const scenario = firstString(params.scenario)?.trim();
  if (scenario) {
    return { kind: 'scenario', id: scenario, intent: normalizeIntent(firstString(params.intent)) };
  }
  return null;
}

/**
 * 消费后要写回 URL 的参数集：无论是否命中场景，直达参数都只消费一次。
 */
export function stripScenarioDeepLinkParams(
  params: ScenarioDeepLinkParams,
): ScenarioDeepLinkParams {
  const next: ScenarioDeepLinkParams = {};
  for (const [key, value] of Object.entries(params)) {
    if (key === 'workflow' || key === 'scenario' || key === 'intent') continue;
    next[key] = value;
  }
  return next;
}
