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
  | { indent: number; text: string }
  // —— 以下变体来自三家客户演示稿会话区高频块的第二批反推（B06~B17），
  //    与首批同一约束：只表达业务语义，禁止 JSON.stringify 产物 ——
  /** 小节标题：摘要内部的分组条，如「动作 1 · 写入脱敏副本」 */
  | { section: string }
  /** 缺口/警告行：AI 主动交出的「我不知道 / 未确认」项（demo B11 缺口区） */
  | { warn: string }
  /** 洞察/结论行：AI 的硬结论，品牌色左条强调（demo B08） */
  | { insight: string; label?: string }
  /** 风险分级行：事实 + 建议动作（demo B12 巡检类主结论） */
  | { risk: 'high' | 'medium'; text: string; action?: string }
  /** 判定行：逐项通过/不通过/需注意/待定（demo B10 判定清单） */
  | { verdict: 'pass' | 'fail' | 'warn' | 'pending'; text: string; note?: string }
  /** 引用行：原话/原文 + 出处定位（demo B17 带引用答案） */
  | { quote: string; source?: string }
  /** 双语行：外文原文 + 中文摘要（demo B16 双语草稿卡） */
  | { original: string; translation?: string }
  /**
   * 字段网格：抽取出的业务字段 2 列大字卡（demo B11 字段抽取区）。
   * 与逐行键值的分工：网格给「客户应当记住的少数硬字段」（值加大加粗），
   * 键值行给过程性上下文。一行网格最多 12 个字段。
   */
  | { fields: Array<{ k: string; v: string }> };

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
const FIELD_GRID_LIMIT = 12;

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

  if (typeof line.section === 'string') {
    const section = clampText(line.section);
    return section === null ? null : { section };
  }

  if (typeof line.warn === 'string') {
    const warn = clampText(line.warn);
    return warn === null ? null : { warn };
  }

  if (typeof line.insight === 'string') {
    const insight = clampText(line.insight);
    if (insight === null) return null;
    const label = clampText(line.label);
    return label !== null ? { insight, label } : { insight };
  }

  if (line.risk === 'high' || line.risk === 'medium') {
    const text = clampText(line.text);
    if (text === null) return null;
    const action = clampText(line.action);
    return action !== null ? { risk: line.risk, text, action } : { risk: line.risk, text };
  }

  if (
    line.verdict === 'pass' || line.verdict === 'fail'
    || line.verdict === 'warn' || line.verdict === 'pending'
  ) {
    const text = clampText(line.text);
    if (text === null) return null;
    const note = clampText(line.note);
    return note !== null ? { verdict: line.verdict, text, note } : { verdict: line.verdict, text };
  }

  if (typeof line.quote === 'string') {
    const quote = clampText(line.quote);
    if (quote === null) return null;
    const source = clampText(line.source);
    return source !== null ? { quote, source } : { quote };
  }

  if (typeof line.original === 'string') {
    const original = clampText(line.original);
    if (original === null) return null;
    const translation = clampText(line.translation);
    return translation !== null ? { original, translation } : { original };
  }

  if (Array.isArray(line.fields)) {
    const fields = line.fields
      .slice(0, FIELD_GRID_LIMIT)
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const field = entry as Record<string, unknown>;
        const k = clampText(field.k);
        if (k === null) return null;
        const v = clampText(field.v) ?? '';
        return { k, v };
      })
      .filter((entry): entry is { k: string; v: string } => entry !== null);
    return fields.length > 0 ? { fields } : null;
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
