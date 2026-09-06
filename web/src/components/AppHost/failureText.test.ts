/**
 * §6.6 客户面失败文案。重点是**纪律**：不写技术归因、不用「上游」这类词。
 */
import { describe, expect, it } from 'vitest';

import {
  CREDITS_EXHAUSTED_NOTICE,
  INVALID_PATH_NOTICE,
  PERMISSION_CHANGED_NOTICE,
  describeAppHostFailure,
  systemLabel,
  type AppHostFailureKind,
} from './failureText';

const KINDS: AppHostFailureKind[] = [
  'handshake_failed',
  'contract_version_mismatch',
  'unavailable',
  'session_expired',
  'system_updating',
  'logged_out',
];

/** 客户面绝不能出现的词：技术归因、内部术语、英文报错。 */
const FORBIDDEN = [
  '上游',
  'iframe',
  'postMessage',
  'attest',
  'nonce',
  'token',
  'JWT',
  'CSP',
  'HTTP',
  '500',
  '403',
  'origin',
  'digest',
  '握手',
];

describe('§6.6 文案表', () => {
  it.each(KINDS)('%s 的文案不含任何技术归因', (kind) => {
    const { message } = describeAppHostFailure(kind, '客户管理');
    for (const word of FORBIDDEN) {
      expect(message.toLowerCase()).not.toContain(word.toLowerCase());
    }
    expect(message.length).toBeGreaterThan(0);
  });

  it('握手/证明失败给系统名 + 已通知技术支持 + 可重试', () => {
    expect(describeAppHostFailure('handshake_failed', '客户管理')).toEqual({
      message: '《客户管理》暂时无法加载，已通知技术支持',
      retryable: true,
    });
  });

  it('系统停用给「暂不可用」且不给重试按钮', () => {
    expect(describeAppHostFailure('unavailable', '客户管理')).toEqual({
      message: '《客户管理》暂不可用',
      retryable: false,
    });
  });

  it('契约版本不兼容不带系统名（与哪个系统无关）', () => {
    expect(describeAppHostFailure('contract_version_mismatch', '客户管理').message).toBe(
      '系统版本不兼容',
    );
  });

  it('系统名缺失时用「该系统」，绝不退化成 installationId', () => {
    for (const name of [null, undefined, '', '   ']) {
      expect(systemLabel(name)).toBe('该系统');
      expect(describeAppHostFailure('handshake_failed', name).message).toContain('《该系统》');
    }
  });

  it('三条独立提示语固定不变', () => {
    expect(PERMISSION_CHANGED_NOTICE).toBe('权限已更新');
    expect(INVALID_PATH_NOTICE).toBe('链接无效，已返回首页');
    expect(CREDITS_EXHAUSTED_NOTICE).toBe('本组织的 AI 额度已用完，已通知管理员');
  });
});
