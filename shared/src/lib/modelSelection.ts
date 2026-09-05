import type { ModelGroup, ModelList } from '../types/models';

/**
 * 模型选择器的纯选择逻辑（对齐 `web/src/components/ChatInput.tsx` 第 245~268 行）。
 *
 * 三条规则：
 * 1. 会话一旦开始且租户未开 `allowCrossGroupSwitch`，只能在当前模型所属分组内换模型；
 * 2. 触发器显示模型展示名，解析不出来时由调用方回落原始 ref；
 * 3. 可选分组 = 未锁定时全部，锁定时只剩锁定分组。
 */

/** 模型 ref 形如 `groupId/modelId`；缺少 `/` 视为非法 ref。 */
export function parseModelRef(
  ref: string | null | undefined,
): { groupId: string; modelId: string } | null {
  if (!ref) return null;
  const slashIdx = ref.indexOf('/');
  if (slashIdx < 0) return null;
  return { groupId: ref.slice(0, slashIdx), modelId: ref.slice(slashIdx + 1) };
}

/** 会话已开始时锁定分组；新会话（无 sessionId）或允许跨组时返回 null。 */
export function resolveLockedModelGroupId(input: {
  sessionId?: string | null;
  selectedModel?: string | null;
  modelList?: Pick<ModelList, 'allowCrossGroupSwitch'> | null;
}): string | null {
  const { sessionId, selectedModel, modelList } = input;
  if (
    !sessionId ||
    sessionId === 'new' ||
    !selectedModel ||
    !modelList ||
    modelList.allowCrossGroupSwitch
  ) {
    return null;
  }
  return parseModelRef(selectedModel)?.groupId ?? null;
}

/** 选中模型的展示名；ref 不合法或分组/模型已下架时返回 null。 */
export function resolveSelectedModelName(
  modelList: Pick<ModelList, 'groups'> | null | undefined,
  selectedModel: string | null | undefined,
): string | null {
  const parsed = parseModelRef(selectedModel);
  if (!modelList || !parsed) return null;
  const group = modelList.groups.find((candidate) => candidate.id === parsed.groupId);
  return group?.models.find((model) => model.id === parsed.modelId)?.name ?? null;
}

/** 锁组时只剩锁定分组，否则全部分组。 */
export function selectableModelGroups(
  modelList: Pick<ModelList, 'groups'> | null | undefined,
  lockedGroupId: string | null,
): ModelGroup[] {
  if (!modelList) return [];
  return modelList.groups.filter((group) => !lockedGroupId || group.id === lockedGroupId);
}
