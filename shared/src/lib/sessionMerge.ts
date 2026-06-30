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
  if (anchorIdx === -1) return server;

  const anchor = local[anchorIdx];
  if (anchor.type !== 'text') return server;
  const anchorContent = anchor.content;

  const serverHasAnchor = server.some(
    (m) => m.type === 'text' && m.content === anchorContent,
  );
  if (serverHasAnchor) return server;

  return [...server, ...local.slice(anchorIdx)];
}
