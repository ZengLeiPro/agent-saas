import type { MessageItem, ActivityGroup, RenderItem, BusinessStepSection } from '../types/message';
import { ACTIVITY_TYPES } from '../types/message';
import {
  isBusinessStepSectionBoundary,
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
   * 非 debug 视图隐藏原始 TodoWrite 工具块，只呈现业务步骤事件。
   */
  debugMode?: boolean;
  /**
   * 章节化：把「步骤 start 事件 → 该步骤终态事件」之间的渲染单元收编为
   * business_step_section（内容留在原时间位置，只加一层归属，不搬运不倒流）。
   * web 开启；mobile 未实现节渲染，保持扁平事件流。
   */
  sectioning?: boolean;
}

function sameStepKey(a: BusinessStepEventItem, b: BusinessStepEventItem): boolean {
  return !!a.todo && !!b.todo && todoItemKey(a.todo) === todoItemKey(b.todo);
}

function markSectionResumePending(section: BusinessStepSection | null): void {
  if (section) section.resumePending = true;
}

/**
 * 外部系统动作行（2026-08-04 曾磊拍板）。
 *
 * 判据只认服务端打的 `presentation.connector` 标记，**不解析 title 字符串**——
 * 「钉钉 · 创建待办」这种形态可以被模型的 description 伪造出来，标记不能。
 */
export function isConnectorActionItem(item: RenderItem): boolean {
  return item.type === 'tool_use' && !!item.presentation?.connector;
}

/**
 * 步骤终态后仍要留痕的外部系统写操作。
 *
 * 只留写操作：查询类看完即走（客户不需要「我查过了」的存档），写操作要有据可查。
 * 不要求一定有 receipt——写操作失败或外部系统没返回单据号时，「动过但没拿到回执」
 * 本身就是客户最该看见的事实，藏起来等于回到「失败糊弄」。
 */
function collectSystemActionIds(section: BusinessStepSection): string[] {
  const ids: string[] = [];
  for (const item of section.items) {
    if (item.type === 'tool_use' && item.presentation?.connector?.write) ids.push(item.id);
  }
  return ids;
}

/**
 * 跨层矛盾规则（2026-08-03 任务 C，曾磊拍板原则：平台事实压过模型叙事）。
 *
 * 触发条件（全部满足才标，宁缺毋滥）：
 * - 步骤终态是 complete，且 outcome tone 不是模型自认的 warn/fail（缺省视为干净完成）；
 * - 步骤区间内**同类操作的最后一次**调用 presentation.status 仍为 warn。
 *
 * 同类分组 key = presentation.title（连接器业务标题天然同类；Read/Write 标题含文件名，
 * 同文件同类；普通 Shell 统一「执行命令」，最后一条命令失败仍谎报 ok 时命中）。
 * 无 presentation.status 的调用不参与判定（旧数据/未接线，解析不确定就不产出）。
 * 失败→重试成功是正常模式：同组最后一次成功即不标。
 */
function detectProcessAnomaly(section: BusinessStepSection): boolean {
  const terminal = section.terminal;
  if (!terminal || terminal.kind !== 'complete') return false;
  const tone = terminal.todo?.outcome?.tone;
  if (tone === 'warn' || tone === 'fail') return false;

  const lastStatusByKey = new Map<string, string>();
  const visitMessage = (item: MessageItem) => {
    if (item.type !== 'tool_use') return;
    if (item.toolName === 'TodoWrite') return;
    const status = item.presentation?.status;
    if (!status) return;
    const key = item.presentation?.title || item.toolName;
    lastStatusByKey.set(key, status);
  };
  for (const item of section.items) {
    if (item.type === 'activity_group') {
      for (const inner of item.items) visitMessage(inner);
    } else if (item.type === 'tool_use') {
      visitMessage(item);
    }
  }

  for (const status of lastStatusByKey.values()) {
    if (status === 'warn') return true;
  }
  return false;
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
  let currentSectionMainTail: RenderItem[] = [];
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
    if (detectProcessAnomaly(section)) section.processAnomaly = true;
    // 终态后过程整体收起，但动过外部系统的写操作要留痕（渲染层据此挑行渲染）
    const systemActionIds = collectSystemActionIds(section);
    if (systemActionIds.length > 0) section.systemActionIds = systemActionIds;
    result.push(section);
    if (currentSectionMainTail.length > 0) {
      result.push(...currentSectionMainTail);
      currentSectionMainTail = [];
    }
  };

  const handleBusinessEvent = (event: BusinessStepEventItem) => {
    if (event.kind === 'reset') {
      if (sectioning) {
        flushGroup(false);
        closeSection();
      }
      return;
    }
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
    // update：计划调整发生在某步进行中时归入该节，否则顶层；reset 已在上方静默消费。
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

    if (sectioning && currentSection && msg.type === 'file_download' && msg.artifactId) {
      // 正式 deliver 的 Artifact 是用户交付物：主区负责发现和下载，步骤详情保留来源归属。
      // 两处只是同一消息的展示投影，不复制 Artifact 本体；未登记的普通文件仍只属于步骤过程。
      flushGroup(false);
      sink().push(msg);
      currentSectionMainTail.push(msg);
      continue;
    }

    if (sectioning && currentSection && msg.type === 'text' && msg.finalOutput) {
      // finalOutput 由 run 成功结束事件追认，比模型调用 TodoWrite 的先后顺序更可信。
      // 模型漏掉终态快照，或先输出总结、后补 TodoWrite 时，最终正文都不能被步骤详情吞掉。
      // 暂存到节尾：若后面还有迟到的终态 TodoWrite，仍可先补全步骤再把正文放回主区。
      flushGroup(false);
      currentSectionMainTail.push(msg);
      continue;
    }

    // 排队中的插话气泡不是叙事边界（2026-08-04 P2-7）：它还没被 Agent 看到，
    // 不得把进行中的业务步骤节提前收口。终态设计下排队消息不进流，这里防御存量。
    const isSectionBoundary = isBusinessStepSectionBoundary(msg);
    const isQueuedUserBubble = msg.type === 'user' && !isSectionBoundary;

    if (isConnectorActionItem(msg)) {
      // 外部系统动作两种视图都独立成行（2026-08-04 曾磊拍板）：
      // 「AI 动了客户自己的钉钉」不是技术噪音，恰恰是这条线要给客户看的东西。
      // 与下一条 debug-only 规则的分工：那条判据是 defaultExpanded（模型说这行重要，
      // 会被模型左右所以只给 debug）；这条判据是平台确定性识别出的连接器命令，客户可见。
      flushGroup(false);
      sink().push(msg);
    } else if (debugMode && msg.type === 'tool_use' && msg.presentation && msg.defaultExpanded) {
      // 只有调试视图允许高价值执行行独立展示；非调试视图必须进入活动分组，
      // 统一显示固定状态，不能用格式化摘要绕过过程信息隔离。
      flushGroup(false);
      sink().push(msg);
    } else if (ACTIVITY_TYPES.has(msg.type)) {
      currentGroup.push(msg);
    } else if (isQueuedUserBubble) {
      // 排队气泡独立渲染但不 closeSection：当前步骤继续保持进行中。
      flushGroup(false);
      sink().push(msg);
    } else if ((msg.type as string) === 'compaction') {
      flushGroup(false);
      // 压缩发生在步骤中途时，不切断 start → terminal 的业务语义。
      // 当前节尚未写入 result，因此先放分界线、稍后再落整节，视觉上等价于
      // 把分界线归位到最近步骤上方，同时保留步骤内压缩前后的完整过程。
      // 若本轮到此结束，渲染层需明确它等待恢复，不能误作尚未开始的 Play 状态。
      markSectionResumePending(currentSection);
      result.push(msg);
    } else if (isSectionBoundary) {
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
