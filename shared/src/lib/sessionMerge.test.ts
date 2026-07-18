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
import { mergeServerMessagesWithLocalTail } from './sessionMerge';
import type { MessageItem } from '../types/message';

const text = (id: string, content: string): MessageItem => ({ id, type: 'text', content });
const user = (id: string, content: string): MessageItem => ({ id, type: 'user', content });
const file = (id: string): MessageItem => ({
  id, type: 'file_download', fileName: 'a.pdf', fileType: '', filePath: 'a.pdf', fileSize: 0,
});

describe('mergeServerMessagesWithLocalTail', () => {
  it('本地无 text 消息时直接返回 server', () => {
    const server = [text('s1', 'hi')];
    const local = [user('u1', '问题')];
    expect(mergeServerMessagesWithLocalTail(server, local)).toBe(server);
  });

  it('server 已存在相同 content 的 text（落盘完成）时返回 server 原样', () => {
    const server = [user('s0', 'q'), text('line-1', '答案')];
    const local = [user('u0', 'q'), text('msg-1', '答案')];
    expect(mergeServerMessagesWithLocalTail(server, local)).toBe(server);
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
