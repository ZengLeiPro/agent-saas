import type { ApiTranscriptBlock } from "@agent/shared";

/**
 * 场景演示剧本。
 *
 * 剧本的 block **必须是真实 ApiTranscriptBlock 结构**，回放时走与真实会话
 * 完全相同的 mapSessionDetailToMessages → MessageItem → ToolBlock 路径。
 * 这是防「两套皮」的物理约束：演示能表达的形态 = 真实会话能表达的形态，
 * 想让演示更好看，只能去改真实渲染器。
 *
 * 剧本内容是**虚构的**，这一点由底部回放条本身向观众声明，不额外加提示文案。
 */

/** 一次按键推进的粒度 */
export interface ReplayStep {
  /** 回放条上显示的这一步在做什么 */
  caption: string;
  /** 本步新增的 transcript block（回放时累加，不替换） */
  blocks: ApiTranscriptBlock[];
}

/**
 * 剧本里每个 presentation 的真实数据来源登记。
 *
 * **治理条款，非可选**：state 缺失或 producer 为空的块不允许合入。
 * 历史教训——[CITE] 引用溯源卡（shared/src/lib/markers.ts）解析器、组件、
 * 测试俱全却零产出方，四个月零使用。没有这张表，本批次会重蹈覆辙。
 *
 * state != "exists" 的条目汇总起来，就是演示到真实之间的距离。
 */
export interface SourceRegistration {
  /** 指向剧本里的哪个块，如 "step2.tool.KnowledgeSearch" */
  blockRef: string;
  /** 未来由谁产出这份 presentation */
  producer: string;
  /**
   * - exists：今天的真实会话已经能产出
   * - needs-change：产出方存在，但要改造才会输出 presentation
   * - missing：产出方根本不存在
   */
  state: "exists" | "needs-change" | "missing";
  /** state != exists 时，缺什么 */
  gap?: string;
}

export interface ReplayScript {
  /** 对应 catalogScenario 的 id */
  scenarioId: string;
  title: string;
  steps: ReplayStep[];
  /**
   * 剧本内嵌的 HTML 产物，键为 [FILE] 标记里的 filePath。
   * 回放视图拦截产物卡点击，直接渲染这里的内容——渲染路径与真实一致，
   * 只有数据源来自剧本。产物 HTML 必须单文件自包含（沙箱 CSP 禁止外链）。
   */
  artifacts?: Record<string, string>;
  sources: SourceRegistration[];
}
