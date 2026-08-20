import type { DetailLine } from '../toolPresentation';

/**
 * 会话区「呈现块」契约。
 *
 * 背景：客户演示稿的会话区共 25 种块，而产品此前只有 13 种 message type，
 * 且全是运行时机制类型（user/text/thinking/tool_use/…），无一业务语义类型。
 * 按老办法每加一种块要跨 shared+web 改 8~13 处硬编码分支——50 种块就是
 * 400+ 处，那不叫底座。
 *
 * 本契约把 25 种收敛为 **3 个顶层 kind**（另有 6 种走现有通道零新增、
 * 2 种由 ToolPresentation 承担）：kind 是闭集，参数是开集，绝大多数「新块」
 * 其实只是既有 kind 的参数变体，新增成本为零。
 *
 * 与 ToolPresentation 的分工：后者描述**一次工具执行**，前者描述**一段呈现**。
 * 两者共用 DetailLine 排版原语，让「结论 + 依据行」在两处同构。
 */

/** 语气。与 web 的 activityStatusStyles 色板对齐。 */
export type PresentationTone = 'neutral' | 'info' | 'success' | 'warn' | 'danger' | 'muted';

export interface BlockAction {
  /** copy/link 由渲染器本地处理；其余需要 interactionId 才生效 */
  kind: 'primary' | 'warning' | 'danger' | 'ghost' | 'copy' | 'link';
  label: string;
  href?: string;
  copyText?: string;
  /**
   * 回写通道。缺省时按钮渲染为 disabled——
   * 不允许出现「点了没反应」的按钮，那正是演示与真实脱节的典型表现。
   */
  interactionId?: string;
}

/** 语气卡：结论、风险提示、拦截说明、等待说明等 */
export interface CalloutBlock {
  kind: 'callout';
  tone: PresentationTone;
  title?: string;
  /** 段落。渲染为纯文本，不解析 markdown——避免与消息正文的渲染管线重复 */
  body: string[];
  /** 复用工具摘要的排版原语，让「结论 + 依据行」同构 */
  detail?: DetailLine[];
  collapsible?: boolean;
  defaultOpen?: boolean;
  actions?: BlockAction[];
}

export interface RecordItem {
  label: string;
  value?: string;
  /** comparison 专用：基准/之前、当前/实际及二者差异。 */
  baseline?: string;
  current?: string;
  delta?: string;
  tag?: { tone: PresentationTone; text: string };
  note?: string;
  /** 整行语气：danger 走删除线，warn 走警示底 */
  tone?: PresentationTone;
  /** 条目级展开详情，复用 DetailLine */
  detail?: DetailLine[];
  /** 等宽显示（哈希 / URL / 提取码） */
  mono?: boolean;
}

/** 条目卡：清单、对照表、检查项、命中列表等 */
export interface RecordsBlock {
  kind: 'records';
  layout: 'rows' | 'grid' | 'comparison' | 'checklist';
  title?: string;
  items: RecordItem[];
  footer?: string;
  actions?: BlockAction[];
}

/** 人审门禁：需要人点头才继续的那一步 */
export interface GateBlock {
  kind: 'gate';
  title: string;
  body?: string[];
  meta?: Array<{ k: string; v: string }>;
  actions: BlockAction[];
}

export type PresentationBlock = CalloutBlock | RecordsBlock | GateBlock;
export type PresentationBlockKind = PresentationBlock['kind'];
