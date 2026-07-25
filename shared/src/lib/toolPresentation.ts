/**
 * 工具执行的「给人看」摘要（ToolPresentation）
 *
 * 与 tool_result 的 `result`（给模型看的原始输出）**并存**，互不替代：
 * - 有 presentation：非 debug 视图渲染结构化摘要，debug 视图额外叠加原始 payload。
 * - 无 presentation：渲染路径与本模块引入前逐像素一致（现状零破坏）。
 *
 * detail 的 5 个变体来自三家客户演示稿 84 个执行摘要块的反推，覆盖其全部
 * 排版形态；**任何情况下都不允许把 JSON.stringify 的产物塞进 detail** ——
 * 观众是业务决策者，不是工程师。原始 payload 有它自己的通道。
 */

import {
  normalizePanelPatches,
  normalizeSystemPanel,
  type PanelPatch,
  type SystemPanelSnapshot,
} from './systemPanel';

/** 摘要行。字符串＝整行纯文本；其余变体各对应一种对齐排版。 */
export type DetailLine =
  /** 纯文本行 */
  | string
  /** 键值对齐：`键    值` */
  | { k: string; v: string }
  /** 树形键值：`├ 键    值` / `└ 键    值` */
  | { tree: '├' | '└'; k: string; v: string }
  /** 编号动作：`① 文本` */
  | { no: number; text: string }
  /** 缩进判定行：按 indent 级别左缩进 */
  | { indent: number; text: string };

/** 外部系统写操作回执。现阶段恒为 undefined，留给连接器回执批次。 */
export interface ToolReceipt {
  /** 外部系统返回的单据/流程标识 */
  id: string;
  /** 目标系统名，如 "钉钉审批" */
  system: string;
  /** 是否已写后回读校验通过。undefined = 未做回读 */
  readBack?: boolean;
}

export interface ToolPresentation {
  /** 业务语言的一句话，如「核对魏德米勒选型表」。为空时调用方回退 getToolDisplayInfo。 */
  title: string;
  /** 结构化摘要行 */
  detail?: DetailLine[];
  /** 业务级状态，与 executionStatus（技术级）正交：技术成功但业务被拦截是合法组合。 */
  status?: 'ok' | 'warn' | 'blocked' | 'waiting';
  receipt?: ToolReceipt;
  /**
   * 本次工具执行对右侧企业系统面板的增量。
   * 面板与 detail 同源——同一条摘要，detail 进会话流，panel 进右侧面板，
   * 面板没有独立数据通道。这是反两套皮的物理约束。
   */
  panel?: PanelPatch[];
  /** 面板底稿。一个会话里只有第一条带 panelBase 的 presentation 生效，后续忽略。 */
  panelBase?: SystemPanelSnapshot;
}

const DETAIL_LINE_LIMIT = 200;
const TEXT_LIMIT = 500;

export function clampText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > TEXT_LIMIT ? `${trimmed.slice(0, TEXT_LIMIT)}…` : trimmed;
}

export function normalizeDetailLine(raw: unknown): DetailLine | null {
  const asText = clampText(raw);
  if (asText !== null) return asText;
  if (!raw || typeof raw !== 'object') return null;

  const line = raw as Record<string, unknown>;

  if (typeof line.k === 'string') {
    const k = clampText(line.k);
    if (k === null) return null;
    const v = clampText(line.v) ?? '';
    return line.tree === '├' || line.tree === '└'
      ? { tree: line.tree, k, v }
      : { k, v };
  }

  if (typeof line.no === 'number' && Number.isFinite(line.no)) {
    const text = clampText(line.text);
    if (text === null) return null;
    return { no: Math.trunc(line.no), text };
  }

  if (typeof line.indent === 'number' && Number.isFinite(line.indent)) {
    const text = clampText(line.text);
    if (text === null) return null;
    return { indent: Math.max(0, Math.min(6, Math.trunc(line.indent))), text };
  }

  return null;
}

const STATUS_VALUES = new Set(['ok', 'warn', 'blocked', 'waiting']);

/**
 * 规范化不可信来源（transcript 文件 / 演示剧本 / 未来的工具产出）的 presentation。
 *
 * 一律返回 null 而非抛错——渲染层永远不应因为摘要脏数据而崩，
 * 返回 null 即自动回退到原始 payload 通道。
 */
export function normalizeToolPresentation(raw: unknown, options?: { allowCustomHtml?: boolean }): ToolPresentation | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as Record<string, unknown>;

  const title = clampText(input.title);
  if (title === null) return null;

  const result: ToolPresentation = { title };

  if (Array.isArray(input.detail)) {
    const detail = input.detail
      .slice(0, DETAIL_LINE_LIMIT)
      .map(normalizeDetailLine)
      .filter((line): line is DetailLine => line !== null);
    if (detail.length > 0) result.detail = detail;
  }

  if (typeof input.status === 'string' && STATUS_VALUES.has(input.status)) {
    result.status = input.status as ToolPresentation['status'];
  }

  const panel = normalizePanelPatches(input.panel);
  if (panel.length > 0) result.panel = panel;

  // allowCustomHtml 只对演示剧本内嵌来源开放；解析 transcript 时恒为 false，
  // 使工具产出的 custom HTML 无法进入面板（安全硬线，见 systemPanel.ts）
  const panelBase = normalizeSystemPanel(input.panelBase, options?.allowCustomHtml === true);
  if (panelBase) result.panelBase = panelBase;

  const receipt = input.receipt as Record<string, unknown> | undefined;
  if (receipt && typeof receipt === 'object') {
    const id = clampText(receipt.id);
    const system = clampText(receipt.system);
    if (id !== null && system !== null) {
      result.receipt = {
        id,
        system,
        ...(typeof receipt.readBack === 'boolean' ? { readBack: receipt.readBack } : {}),
      };
    }
  }

  return result;
}
