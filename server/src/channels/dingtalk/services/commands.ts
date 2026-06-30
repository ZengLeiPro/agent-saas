/**
 * DingTalk Command Handlers
 *
 * 消息路由层的命令识别与处理（如 reset、model 命令），独立于投递逻辑。
 */

import type { SendStatusFn } from './sessionWebhookSender.js';
import type { PublicModelList, ResolvedModel } from '../../../app/models.js';

// ============================================
// Reset Command
// ============================================

export function isResetCommand(content: string): boolean {
  const resetKeywords = ['reset', 'restart', '重置', '重新开始'];
  return resetKeywords.includes(content.trim().toLowerCase());
}

export async function handleResetCommand(
  conversationId: string,
  sendStatus: SendStatusFn,
  clearSession: (conversationId: string) => void,
): Promise<void> {
  clearSession(conversationId);
  await sendStatus('会话已重置，可以开始新的对话。');
}

// ============================================
// Model Command
// ============================================

export type ModelResolver = (ref: string) => ResolvedModel | null;

export interface ModelCommandDeps {
  getModelRef: (conversationId: string) => string | undefined;
  saveModelRef: (conversationId: string, modelRef: string | undefined) => void;
  modelList: PublicModelList | null;
  modelResolver: ModelResolver | undefined;
}

const MODEL_CMD_RE = /^\/model(?:\s+(.*))?$/i;

export function isModelCommand(content: string): boolean {
  return MODEL_CMD_RE.test(content.trim());
}

export async function handleModelCommand(
  content: string,
  conversationId: string,
  sendStatus: SendStatusFn,
  deps: ModelCommandDeps,
): Promise<void> {
  if (!deps.modelList || !deps.modelResolver) {
    await sendStatus('当前未配置多模型，无法切换。');
    return;
  }

  const match = content.trim().match(MODEL_CMD_RE);
  const arg = match?.[1]?.trim();

  if (!arg) {
    await sendStatus(formatModelList(deps.modelList, deps.getModelRef(conversationId)));
    return;
  }

  if (arg.toLowerCase() === 'reset') {
    deps.saveModelRef(conversationId, undefined);
    await sendStatus('已恢复为默认模型');
    return;
  }

  const resolved = fuzzyMatchModel(arg, deps.modelList);
  if (!resolved) {
    await sendStatus(`未找到匹配的模型: ${arg}\n\n输入 /model 查看可用模型列表`);
    return;
  }

  // 通过 modelResolver 验证引用有效
  const result = deps.modelResolver(resolved.ref);
  if (!result) {
    await sendStatus(`模型引用无效: ${resolved.ref}`);
    return;
  }

  deps.saveModelRef(conversationId, resolved.ref);
  await sendStatus(`模型已切换为 ${resolved.name}`);
}

interface FuzzyMatchResult {
  ref: string;
  name: string;
}

function fuzzyMatchModel(arg: string, modelList: PublicModelList): FuzzyMatchResult | null {
  // 精确匹配 groupId/modelId
  if (arg.includes('/')) {
    for (const group of modelList.groups) {
      for (const model of group.models) {
        if (`${group.id}/${model.id}` === arg) {
          return { ref: `${group.id}/${model.id}`, name: model.name };
        }
      }
    }
    return null;
  }

  // 模糊匹配：遍历所有 group，按 modelId 或 modelName（不区分大小写）
  const lower = arg.toLowerCase();
  for (const group of modelList.groups) {
    for (const model of group.models) {
      if (model.id.toLowerCase() === lower || model.name.toLowerCase() === lower) {
        return { ref: `${group.id}/${model.id}`, name: model.name };
      }
    }
  }
  return null;
}

function formatModelList(modelList: PublicModelList, currentRef: string | undefined): string {
  const currentDisplay = currentRef
    ? findModelName(modelList, currentRef) ?? currentRef
    : '默认';

  let text = `当前模型: ${currentDisplay}`;
  if (currentRef) text += ` (${currentRef})`;
  text += '\n\n可用模型:';

  for (const group of modelList.groups) {
    text += `\n-- ${group.name} --`;
    for (const model of group.models) {
      const ref = `${group.id}/${model.id}`;
      const marker = ref === currentRef ? ' [当前]' : '';
      text += `\n  ${model.id}    ${model.name}${marker}`;
    }
  }

  text += '\n\n用法: /model <名称> 切换模型，/model reset 恢复默认';
  return text;
}

function findModelName(modelList: PublicModelList, ref: string): string | null {
  const slashIdx = ref.indexOf('/');
  if (slashIdx < 0) return null;
  const groupId = ref.slice(0, slashIdx);
  const modelId = ref.slice(slashIdx + 1);
  const group = modelList.groups.find((g) => g.id === groupId);
  const model = group?.models.find((m) => m.id === modelId);
  return model?.name ?? null;
}
