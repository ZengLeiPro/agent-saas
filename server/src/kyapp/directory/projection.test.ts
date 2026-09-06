/**
 * 钉钉目录源的留空实现语义（WP2b Phase A ③）。
 * 关键约束：**未配置时必须炸，不能静默返回空目录**——空目录会被差分成
 * 「全组织离职」的删除墓碑，消费端一批 `user.remove` 下去就把客户的人全清了。
 */
import { describe, expect, it } from 'vitest';

import {
  DINGTALK_DIRECTORY_UNAVAILABLE_MESSAGE,
  DingTalkDirectoryNotConfiguredError,
  DingTalkDirectorySource,
} from './projection.js';

describe('DingTalkDirectorySource（本轮留空实现）', () => {
  it('构造即抛「未配置」，且错误信息点明前置是钉钉后台授权', () => {
    expect(() => new DingTalkDirectorySource()).toThrow(DingTalkDirectoryNotConfiguredError);
    expect(() => new DingTalkDirectorySource()).toThrow(/通讯录只读/u);
    expect(DINGTALK_DIRECTORY_UNAVAILABLE_MESSAGE).toContain('钉钉');
  });

  it('绝不降级成空目录：构造失败后拿不到任何可用实例', () => {
    let instance: DingTalkDirectorySource | null = null;
    try {
      instance = new DingTalkDirectorySource();
    } catch (error) {
      expect(error).toBeInstanceOf(DingTalkDirectoryNotConfiguredError);
    }
    expect(instance).toBeNull();
  });
});
