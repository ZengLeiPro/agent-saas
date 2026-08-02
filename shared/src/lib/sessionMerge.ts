import type { MessageItem } from '../types/message';

/**
 * 合并服务端 transcript 消息列表与本地实时流式消息列表，保留本地尾部（若服务端尚未落盘）。
 *
 * 背景：`done` 事件可能先于 SDK 把最后一条 assistant text 写入 transcript jsonl，此时 refresh
 * 拉到的 server 列表缺尾部；若无条件替换会抹掉本地已显示的最后一条消息。
 *
 * 算法：以本地最后一条 `type === 'text'`（assistant 流式文本）消息为锚点——server 中若已存在
 * 相同 content 的 text 消息，说明落盘已完成，直接用 server；否则把本地从锚点开始的尾部追加到
 * server 末尾，保留本地 id（server id 形如 `line-N-...`，本地 id 形如 `msg-ts-n`，不会冲突）。
 */
export function mergeServerMessagesWithLocalTail(
  server: MessageItem[],
  local: MessageItem[],
): MessageItem[] {
  let anchorIdx = -1;
  for (let i = local.length - 1; i >= 0; i--) {
    if (local[i].type === 'text') {
      anchorIdx = i;
      break;
    }
  }

  // 第二锚点：本地仍在途（pending/queued）的用户气泡。插话在服务端投影完成前
  // 可能被 text 锚点逻辑漏掉——插话回退 run 的流式 text 会成为新锚点，把 queued
  // 气泡挤到锚点之前而整体丢弃（气泡消失后，回退 run 的 done 还会失去归属目标）。
  let inflightUserIdx = -1;
  for (let i = local.length - 1; i >= 0; i--) {
    const m = local[i];
    if (m.type === 'user' && (m.status === 'pending' || m.status === 'queued')) {
      inflightUserIdx = i;
      break;
    }
  }
  // 服务端已投影（最后一条 user 同内容）则不再保留本地气泡，避免重复。只比较
  // 最后一条 user，不能在整个历史里 some：用户重复发送同一句话很常见，旧消息命中会
  // 误吞本轮在途气泡。
  let lastServerUserContent: string | undefined;
  for (let i = server.length - 1; i >= 0; i--) {
    if (server[i].type === 'user') {
      lastServerUserContent = (server[i] as Extract<MessageItem, { type: 'user' }>).content;
      break;
    }
  }
  const inflightUserProjected = inflightUserIdx >= 0
    && lastServerUserContent === (local[inflightUserIdx] as Extract<MessageItem, { type: 'user' }>).content;
  const inflightTailStart = inflightUserIdx >= 0 && !inflightUserProjected ? inflightUserIdx : -1;

  if (anchorIdx === -1) {
    return inflightTailStart >= 0 ? [...server, ...local.slice(inflightTailStart)] : server;
  }

  const anchor = local[anchorIdx];
  if (anchor.type !== 'text') return server;
  const localTailAfterAnchor = local.slice(anchorIdx + 1);
  const anchorContent = anchor.content;

  // 空流式占位不应作为消息追加，但仍需保留其后的 tool/subagent 等本地尾部。
  if (anchorContent.trim().length === 0) {
    const tail = inflightTailStart >= 0 && inflightTailStart < anchorIdx
      ? local.slice(inflightTailStart)
      : localTailAfterAnchor;
    return tail.length === 0 ? server : [...server, ...tail];
  }

  // 只检查服务端最后一条 text，避免历史中的同文消息误吞当前回复。
  let lastServerTextContent: string | undefined;
  for (let i = server.length - 1; i >= 0; i--) {
    const message = server[i];
    if (message.type === 'text') {
      lastServerTextContent = message.content;
      break;
    }
  }

  // startsWith 同时覆盖全文相等；不做 trim/模糊匹配，避免误吞不同消息。
  // 服务端已有锚点 text 时，锚点前的在途气泡必然先于该 text 被消费/投影（transcript
  // 顺序保证），只保留锚点后的本地尾部即可。
  if (lastServerTextContent?.startsWith(anchorContent)) {
    return localTailAfterAnchor.length === 0
      ? server
      : [...server, ...localTailAfterAnchor];
  }

  const startIdx = inflightTailStart >= 0 && inflightTailStart < anchorIdx
    ? inflightTailStart
    : anchorIdx;
  return [...server, ...local.slice(startIdx)];
}

/**
 * 把服务端增量消息并入一个完整的本地快照。
 *
 * transcript block id 在同一会话内稳定；服务端会在增量中附带一小段重叠尾部，
 * 因而从首个重叠 id 起整体替换本地尾部：既刷新 tool/duration 状态，也清掉游标后
 * 尚未落盘时产生的临时本地 id。极端情况下找不到重叠消息，再退回按 id 合并。
 */
export function mergeSessionMessageDelta(
  base: MessageItem[],
  delta: MessageItem[],
): MessageItem[] {
  if (delta.length === 0) return base;

  const baseIndexById = new Map(base.map((message, index) => [message.id, index]));
  const overlapIndex = delta
    .map((message) => baseIndexById.get(message.id))
    .find((index): index is number => index !== undefined);
  const result = overlapIndex === undefined ? [...base] : base.slice(0, overlapIndex);
  const indexById = new Map(result.map((message, index) => [message.id, index]));
  for (const message of delta) {
    const existingIndex = indexById.get(message.id);
    if (existingIndex === undefined) {
      indexById.set(message.id, result.length);
      result.push(message);
    } else {
      result[existingIndex] = message;
    }
  }
  return result;
}

/** 向前分页：历史页放在现有消息之前，重叠消息以新页面版本为准。 */
export function mergeSessionMessagePage(
  base: MessageItem[],
  page: MessageItem[],
): MessageItem[] {
  if (page.length === 0) return base;
  const pageIds = new Set(page.map((message) => message.id));
  return [...page, ...base.filter((message) => !pageIds.has(message.id))];
}
