import type { MessageItem, ActivityGroup, RenderItem, BusinessStepSection } from '../types/message';
import { ACTIVITY_TYPES } from '../types/message';
import {
  isTerminalStepEvent,
  projectBusinessStepEvents,
  todoItemKey,
  type BusinessStepEventItem,
} from './extractTodos';

/** Check if activity group is active (has streaming/running items) */
function isGroupActive(items: MessageItem[], isLastGroup: boolean, loading: boolean): boolean {
  for (const item of items) {
    if ('streaming' in item && item.streaming) return true;
    if (item.type === 'subagent' && item.status === 'running') return true;
    if (item.type === 'tool_use' && !item.resultReady && isLastGroup && loading) return true;
  }
  return isLastGroup && loading;
}

export interface GroupMessagesOptions {
  /**
   * debug 视图保留 TodoWrite 原始工具块（与业务步骤事件并存，语义=看原始数据）；
   * 非 debug 视图 TodoWrite 从主流隐藏——总览由 TodoPanel 承载、叙事由事件承载。
   */
  debugMode?: boolean;
  /**
   * 章节化：把「步骤 start 事件 → 该步骤终态事件」之间的渲染单元收编为
   * business_step_section（内容留在原时间位置，只加一层归属，不搬运不倒流）。
   * web 开启；mobile 未实现节渲染，保持扁平事件流。
   */
  sectioning?: boolean;
}

/** 全局叙事边界：这些消息不属于任何业务步骤节，出现时先封当前节。 */
const SECTION_BREAKING_TYPES = new Set(['user', 'user-voice', 'system_event', 'system-error', 'compaction']);

function sameStepKey(a: BusinessStepEventItem, b: BusinessStepEventItem): boolean {
  return !!a.todo && !!b.todo && todoItemKey(a.todo) === todoItemKey(b.todo);
}

/** Group flat message array into render units (pure function, O(n) single pass) */
export function groupMessages(
  messages: MessageItem[],
  loading: boolean,
  options?: GroupMessagesOptions,
): RenderItem[] {
  const result: RenderItem[] = [];
  let currentGroup: MessageItem[] = [];
  let currentSection: BusinessStepSection | null = null;
  const debugMode = options?.debugMode === true;
  const sectioning = options?.sectioning === true;
  const businessProjection = projectBusinessStepEvents(messages, loading);

  /** 当前落点：开放的步骤节内，或顶层。 */
  const sink = (): RenderItem[] => (currentSection ? currentSection.items : result);

  const flushGroup = (isLast: boolean) => {
    if (currentGroup.length === 0) return;
    const items = currentGroup;
    currentGroup = [];
    sink().push({
      type: 'activity_group',
      id: `ag-${items[0].id}`,
      items,
      isActive: isGroupActive(items, isLast, loading),
    } satisfies ActivityGroup);
  };

  const closeSection = (atStreamEnd = false) => {
    if (!currentSection) return;
    const section = currentSection;
    currentSection = null;
    // 开放节（无终态）只有在流末尾且 run 仍活跃时才算「进行中」。
    section.isActive = !section.terminal && atStreamEnd && loading;
    result.push(section);
  };

  const handleBusinessEvent = (event: BusinessStepEventItem) => {
    if (!sectioning) {
      flushGroup(false);
      result.push(event);
      return;
    }
    if (event.kind === 'plan') {
      flushGroup(false);
      closeSection();
      result.push(event);
      return;
    }
    if (event.kind === 'start') {
      flushGroup(false);
      closeSection();
      currentSection = {
        type: 'business_step_section',
        id: `sec-${event.id}`,
        start: event,
        items: [],
        isActive: false,
      };
      return;
    }
    if (isTerminalStepEvent(event)) {
      flushGroup(false);
      if (currentSection && sameStepKey(currentSection.start, event)) {
        currentSection.terminal = event;
        closeSection();
      } else {
        // 没有对应开放节（模型未 start 直接终态，或节被打断）：独立渲染终态块。
        closeSection();
        result.push(event);
      }
      return;
    }
    // update：计划调整发生在某步进行中时归入该节，否则顶层。
    flushGroup(false);
    sink().push(event);
  };

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // 业务步骤事件插在产生它的 TodoWrite 消息位置：终态/开始事件按时间线性出现，
    // 与 thinking / 工具活动 / 正文同向生长（时间叙事，不做原地更新的看板）。
    const anchoredEvents = businessProjection.eventsByAnchor.get(msg.id);
    if (anchoredEvents) {
      for (const event of anchoredEvents) handleBusinessEvent(event);
    }
    if (!debugMode && businessProjection.hiddenMessageIds.has(msg.id)) {
      continue;
    }

    if (msg.type === 'tool_use' && msg.presentation && msg.defaultExpanded) {
      // 数据源（剧本 / 未来的服务端规则）用 defaultOpen 声明的高价值执行行，
      // 是「AI 在动系统」的可见痕迹，不允许被活动分组吞成「已完成 N 条」。
      // 判据不是「有没有摘要」——真实会话几乎所有工具都有摘要，全拆会刷屏；
      // 而是「数据源是否点名它值得上主流」。真实会话 defaultOpen 恒 false（parse.ts），行为不变。
      flushGroup(false);
      sink().push(msg);
    } else if (ACTIVITY_TYPES.has(msg.type)) {
      currentGroup.push(msg);
    } else if (SECTION_BREAKING_TYPES.has(msg.type)) {
      flushGroup(false);
      closeSection();
      result.push(msg);
    } else {
      // text / file_download / permission_request / ask_user 等：
      // 步骤进行期间的输出与交互属于该步骤的过程，归入开放节。
      flushGroup(false);
      sink().push(msg);
    }
  }
  flushGroup(true);
  closeSection(true);

  return result;
}
