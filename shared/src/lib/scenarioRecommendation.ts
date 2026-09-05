/**
 * 场景空态的推荐排序 —— 从 Web `EmptyChatRecommendCards` / `EmptySessionScenarios`
 * 的组件内逻辑下沉，供 Web 与移动端原生空态共用同一套打分与匹配规则。
 *
 * 说明：本模块只处理 v1/v2 的 legacy 场景库（`GET /api/scenarios`）。
 * v3 工作流目录的排序另有 `sortWorkflowScenarios`，不在此处重复。
 */
import type { FirstAhaMode, ScenarioItem } from '../types/scenario';

/** 首次 aha 成本越低分越高：零输入示例 > 粘贴 > 上传 > 语音 */
const AHA_SCORE: Record<FirstAhaMode, number> = {
  zero_input_example: 4,
  paste_then_result: 3,
  upload_then_result: 2,
  voice_then_result: 1,
};

/** 空态推荐卡默认张数（Web 三张推荐卡） */
export const RECOMMENDATION_COUNT = 3;

export interface ScenarioRoleRef {
  id: string;
  name: string;
}

/**
 * 用用户岗位文本匹配场景库角色 id。
 * 角色名按 `/` 拆分成多个别名，任一别名与岗位互为子串即命中。
 */
export function matchRoleIdByPosition(
  roles: readonly ScenarioRoleRef[],
  position?: string | null,
): string | null {
  const p = position?.trim();
  if (!p) return null;
  for (const role of roles) {
    const segments = role.name
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean);
    if (segments.some((segment) => p.includes(segment) || (p.length >= 2 && segment.includes(p)))) {
      return role.id;
    }
  }
  return null;
}

function sortByAhaCost(candidates: readonly ScenarioItem[]): ScenarioItem[] {
  return [...candidates].sort((a, b) => {
    const ahaDelta =
      (AHA_SCORE[b.firstAhaMode ?? 'zero_input_example'] ?? 0) -
      (AHA_SCORE[a.firstAhaMode ?? 'zero_input_example'] ?? 0);
    if (ahaDelta !== 0) return ahaDelta;
    if (a.mode !== b.mode) return a.mode === 'recurring' ? -1 : 1;
    const depA = a.dataDependencyLevel === 'zero' ? 0 : 1;
    const depB = b.dataDependencyLevel === 'zero' ? 0 : 1;
    if (depA !== depB) return depA - depB;
    return a.id.localeCompare(b.id);
  });
}

/**
 * v2 推荐卡：先按 aha 成本排序，命中岗位的场景整体前置，再截断到 `count`。
 * 与 Web `pickRoleTop3` 同构（此处是可复用版本）。
 */
export function pickRoleTopScenarios(
  scenarios: readonly ScenarioItem[],
  roleId: string | null,
  count = RECOMMENDATION_COUNT,
): ScenarioItem[] {
  if (!roleId) return sortByAhaCost(scenarios).slice(0, count);
  const roleCandidates = sortByAhaCost(scenarios.filter((scenario) => scenario.role === roleId));
  const fallbackCandidates = sortByAhaCost(
    scenarios.filter((scenario) => scenario.role !== roleId),
  );
  return [...roleCandidates, ...fallbackCandidates].slice(0, count);
}

/** v1 起手行的固定精选顺序，与 Web 保持一致 */
const CURATED_RECOMMEND_IDS = [
  'boss-competitor-daily',
  'sales-customer-profile',
  'hr-meeting-minutes',
];

/**
 * v1 起手行：岗位命中最多 2 条 → 精选 id → 按角色去重补齐 → 剩余补齐。
 */
export function pickRecommendedScenarios(
  scenarios: readonly ScenarioItem[],
  count = RECOMMENDATION_COUNT,
  preferredRoleId?: string | null,
): ScenarioItem[] {
  const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  const picked: ScenarioItem[] = [];
  if (preferredRoleId) {
    for (const item of scenarios) {
      if (picked.length >= Math.min(2, count)) break;
      if (item.role === preferredRoleId) picked.push(item);
    }
  }
  for (const id of CURATED_RECOMMEND_IDS) {
    const item = byId.get(id);
    if (item && !picked.includes(item)) picked.push(item);
    if (picked.length >= count) return picked.slice(0, count);
  }
  const rest = [...scenarios].sort((left, right) => left.id.localeCompare(right.id));
  const usedRoles = new Set(picked.map((item) => item.role));
  for (const item of rest) {
    if (picked.length >= count) break;
    if (picked.includes(item) || usedRoles.has(item.role)) continue;
    picked.push(item);
    usedRoles.add(item.role);
  }
  for (const item of rest) {
    if (picked.length >= count) break;
    if (!picked.includes(item)) picked.push(item);
  }
  return picked.slice(0, count);
}

export type ScenarioActionTone = 'success' | 'muted';

export interface ScenarioActionMeta {
  label: string;
  tone: ScenarioActionTone;
}

/**
 * 推荐卡右下角的动作文案：零数据依赖可以「直接试」，否则只能「预填任务」。
 * 与 Web `EmptyChatRecommendCards` 的三元判断一致。
 */
export function resolveScenarioActionMeta(
  scenario: Pick<ScenarioItem, 'dataDependencyLevel'>,
): ScenarioActionMeta {
  const zeroData = scenario.dataDependencyLevel === 'zero' || !scenario.dataDependencyLevel;
  return zeroData ? { label: '直接试', tone: 'success' } : { label: '预填任务', tone: 'muted' };
}
