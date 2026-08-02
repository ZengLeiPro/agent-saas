import { describe, expect, it } from 'vitest';
import { isTransientNetworkError } from '../utils/transientNetworkError.js';

describe('isTransientNetworkError', () => {
  it.each([
    'Connection terminated',
    'Connection terminated unexpectedly',
    'Connection terminated due to connection timeout',
  ])('识别 node-postgres 无 errno 的瞬态断连：%s', (message) => {
    expect(isTransientNetworkError(new Error(message))).toBe(true);
  });

  it('继续识别带 errno code 的网络错误', () => {
    expect(isTransientNetworkError(Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }))).toBe(true);
  });

  it('不吞掉普通业务异常或相似但不精确的文本', () => {
    expect(isTransientNetworkError(new Error('Connection terminated unexpectedly while parsing data'))).toBe(false);
    expect(isTransientNetworkError(new Error('unexpected application failure'))).toBe(false);
    expect(isTransientNetworkError('Connection terminated unexpectedly')).toBe(false);
  });
});
