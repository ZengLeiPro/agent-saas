/**
 * sessionMerge.ts 测试
 *
 * mergeServerMessagesWithLocalTail：以本地最后一条 text 为锚点合并 server/local。
 * 覆盖：
 * - 本地无 text 锚点 → 直接返回 server
 * - server 已含相同 content 的 text（落盘完成）→ 返回 server
 * - server 缺尾部 → 把锚点起的本地尾部追加到 server 末尾
 * - 锚点后还有非 text 消息（file_download 等）时整段尾部都要保留
 */
import { describe, expect, it } from 'vitest';
import {
  mergeServerMessagesWithLocalTail,
  mergeSessionMessageDelta,
  mergeSessionMessagePage,
} from './sessionMerge';
import type { MessageItem } from '../types/message';

const text = (id: string, content: string): MessageItem => ({ id, type: 'text', content });
const user = (id: string, content: string): MessageItem => ({ id, type: 'user', content });
const file = (id: string): MessageItem => ({
  id, type: 'file_download', fileName: 'a.pdf', fileType: '', filePath: 'a.pdf', fileSize: 0,
});
const compaction = (id: string, summary: string, coveredEventCount: number): MessageItem => ({
  id,
  type: 'compaction',
  status: 'done',
  summary,
  coveredEventCount,
} as unknown as MessageItem);

describe('mergeServerMessagesWithLocalTail', () => {
  it('本地无 text 消息时直接返回 server', () => {
    const server = [text('s1', 'hi')];
    const local = [user('u1', '问题')];
    expect(mergeServerMessagesWithLocalTail(server, local)).toBe(server);
  });

  it('本地无 text 但有 queued 插话时保留该气泡', () => {
    const server = [user('s1', '原问题'), text('s2', '原回答')];
    const queued: MessageItem = {
      id: 'u2', type: 'user', content: '插话', status: 'queued', clientMsgId: 'c2',
    };
    const local = [...server, queued];
    expect(mergeServerMessagesWithLocalTail(server, local)).toEqual([...server, queued]);
  });

  it('历史中有同文 user 但最后一条 user 不同，仍保留本轮 queued 气泡', () => {
    const server = [user('s0', '重复内容'), text('s1', '旧回答'), user('s2', '原问题'), text('s3', '原回答')];
    const queued: MessageItem = {
      id: 'u2', type: 'user', content: '重复内容', status: 'queued', clientMsgId: 'c2',
    };
    expect(mergeServerMessagesWithLocalTail(server, [...server, queued])).toEqual([...server, queued]);
  });

  it('回退 run 已开始流式但尚未落盘时保留 queued 气泡及其后的 text', () => {
    const server = [user('s1', '原问题'), text('s2', '原回答')];
    const queued: MessageItem = {
      id: 'u2', type: 'user', content: '插话', status: 'queued', clientMsgId: 'c2',
    };
    const fallbackText = text('local-fallback', '回退回答');
    const local = [...server, queued, fallbackText];
    expect(mergeServerMessagesWithLocalTail(server, local)).toEqual([
      ...server,
      queued,
      fallbackText,
    ]);
  });

  it('server 已存在相同 content 的 text（落盘完成）时返回 server 原样', () => {
    const server = [user('s0', 'q'), text('line-1', '答案')];
    const local = [user('u0', 'q'), text('msg-1', '答案')];
    expect(mergeServerMessagesWithLocalTail(server, local)).toBe(server);
  });

  it('服务端已投影同一次压缩时不再追加本地临时分界线', () => {
    const server = [
      user('line-1', '问题'),
      text('line-2', '回答'),
      compaction('line-3-compaction', '历史摘要', 42),
    ];
    const local = [
      user('msg-1', '问题'),
      text('msg-2', '回答'),
      compaction('msg-3', '历史摘要', 42),
    ];

    expect(mergeServerMessagesWithLocalTail(server, local)).toBe(server);
  });

  it('不同的压缩分界线仍作为尚未投影的本地尾部保留', () => {
    const server = [
      user('line-1', '问题'),
      text('line-2', '回答'),
      compaction('line-3-compaction', '旧摘要', 40),
    ];
    const latest = compaction('msg-3', '新摘要', 48);
    const local = [user('msg-1', '问题'), text('msg-2', '回答'), latest];

    expect(mergeServerMessagesWithLocalTail(server, local)).toEqual([...server, latest]);
  });

  // 回归：2026-08-04 生产会话 b1c23712 用户气泡被复制 6 份。preserveTail 刷新路径
  // 的 baseMessages 与 localMsgs 同源（useSession.ts:399 / :509），server 基底本就
  // 含有本地尾部；run 因上游 429 失败时尾形恰为 [.., text, user]，锚点之后的用户
  // 气泡每刷新一次就被原样复制一份，且沿用同一 id 撞坏列表虚拟 key。
  it('server 基底与本地同源时不重复追加已投影的尾部', () => {
    const local = [user('msg-0', '上一问'), text('msg-1', '上一答'), user('msg-2', '开始做吧')];
    expect(mergeServerMessagesWithLocalTail(local, local)).toBe(local);
  });

  it('server 基底与本地同源时反复合并保持幂等', () => {
    const local = [user('msg-0', '上一问'), text('msg-1', '上一答'), user('msg-2', '开始做吧')];
    let merged = mergeServerMessagesWithLocalTail(local, local);
    merged = mergeServerMessagesWithLocalTail(merged, merged);
    merged = mergeServerMessagesWithLocalTail(merged, merged);
    expect(merged).toEqual(local);
  });

  it('server 最后一条 text 扩展了本地流式前缀时不重复追加本地 text', () => {
    const server = [user('s0', 'q'), text('line-1', 'abcdef')];
    const local = [user('u0', 'q'), text('msg-1', 'abc')];
    expect(mergeServerMessagesWithLocalTail(server, local)).toBe(server);
  });

  it('仅较早的 server text 匹配时仍保留本地尾部', () => {
    const server = [text('line-1', 'abc'), text('line-2', '另一条回复')];
    const local = [text('msg-1', 'abc')];
    expect(mergeServerMessagesWithLocalTail(server, local)).toEqual([
      ...server,
      local[0],
    ]);
  });

  it('server 缺失本地尾部时，把锚点起的本地尾部追加到 server 末尾', () => {
    const server = [user('s0', 'q')];
    const local = [user('u0', 'q'), text('msg-1', '最后一句还没落盘')];
    const merged = mergeServerMessagesWithLocalTail(server, local);
    expect(merged).toEqual([
      { id: 's0', type: 'user', content: 'q' },
      { id: 'msg-1', type: 'text', content: '最后一句还没落盘' },
    ]);
    // 保留本地 id，不修改原数组
    expect(merged).not.toBe(server);
  });

  it.each(['', '   \n'])('空或纯空白流式 text（%j）不追加', (content) => {
    const server = [user('s0', 'q')];
    const local: MessageItem[] = [
      user('u0', 'q'),
      text('msg-1', content),
    ];
    expect(mergeServerMessagesWithLocalTail(server, local)).toBe(server);
  });

  it('server 覆盖本地 text 时仍保留锚点后的其他本地尾部 item', () => {
    const server = [user('s0', 'q'), text('line-1', 'abcdef')];
    const local = [
      user('u0', 'q'),
      text('msg-1', 'abc'),
      file('msg-file'),
    ];
    expect(mergeServerMessagesWithLocalTail(server, local)).toEqual([
      server[0],
      server[1],
      local[2],
    ]);
  });

  it('锚点选取本地最后一条 text，其后的非 text 尾部也一并保留', () => {
    const server = [user('s0', 'q')];
    const local = [
      user('u0', 'q'),
      text('msg-1', '未落盘文本'),
      file('msg-file'),
    ];
    const merged = mergeServerMessagesWithLocalTail(server, local);
    expect(merged).toEqual([
      { id: 's0', type: 'user', content: 'q' },
      { id: 'msg-1', type: 'text', content: '未落盘文本' },
      expect.objectContaining({ id: 'msg-file', type: 'file_download' }),
    ]);
  });

  it('存在多条本地 text 时以最后一条为锚点', () => {
    const server = [text('line-1', '第一段')];
    const local = [text('msg-1', '第一段'), text('msg-2', '第二段未落盘')];
    const merged = mergeServerMessagesWithLocalTail(server, local);
    // 锚点是 '第二段未落盘'，server 无此 content，追加从锚点开始的尾部（仅第二段）
    expect(merged).toEqual([
      { id: 'line-1', type: 'text', content: '第一段' },
      { id: 'msg-2', type: 'text', content: '第二段未落盘' },
    ]);
  });
});

describe('mergeSessionMessagePage', () => {
  it('把更早页面放到现有消息之前，并用页面版本刷新重叠消息', () => {
    const base = [text('line-3', '旧版本'), text('line-4', '最新')];
    const page = [user('line-1', '问题'), text('line-2', '回答'), text('line-3', '新版本')];

    expect(mergeSessionMessagePage(base, page)).toEqual([
      page[0],
      page[1],
      page[2],
      base[1],
    ]);
  });

  it('空页面保持原数组引用', () => {
    const base = [text('line-1', '回答')];
    expect(mergeSessionMessagePage(base, [])).toBe(base);
  });
});

describe('mergeSessionMessageDelta', () => {
  it('按稳定 id 原位刷新重叠消息，并在尾部追加新消息', () => {
    const base: MessageItem[] = [
      user('line-1', '问题'),
      { id: 'line-2', type: 'tool_use', toolName: 'Bash', toolInput: '{}', toolId: 'tool-1', streaming: false },
    ];
    const delta: MessageItem[] = [
      {
        id: 'line-2',
        type: 'tool_use',
        toolName: 'Bash',
        toolInput: '{}',
        toolId: 'tool-1',
        streaming: false,
        executionStatus: 'completed',
        result: 'ok',
        resultReady: true,
      },
      text('line-3', '完成'),
    ];

    expect(mergeSessionMessageDelta(base, delta)).toEqual([
      base[0],
      delta[0],
      delta[1],
    ]);
    expect(base[1]).not.toHaveProperty('result');
  });

  it('从首个重叠 id 起替换尾部，清掉游标后遗留的临时本地消息', () => {
    const base = [
      user('line-1', '问题'),
      text('line-2', '旧回复'),
      text('msg-local', '本地临时尾部'),
    ];
    const delta = [
      text('line-2', '旧回复'),
      text('line-3', '已落盘的新回复'),
    ];

    expect(mergeSessionMessageDelta(base, delta)).toEqual([
      base[0],
      delta[0],
      delta[1],
    ]);
  });
});
