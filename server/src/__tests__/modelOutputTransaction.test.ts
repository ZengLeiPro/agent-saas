import { describe, expect, it } from 'vitest';

import {
  resolveModelOutputTransactionMode,
  supportsReplaceableDrafts,
} from '../runtime/modelOutputTransaction.js';

describe('model output transaction contract', () => {
  it('以持久化 outputTransactionMode 为唯一事实源', () => {
    expect(resolveModelOutputTransactionMode({
      outputTransactionMode: 'terminal_buffered',
      replaceableDrafts: true,
    })).toBe('terminal_buffered');
    expect(supportsReplaceableDrafts({
      outputTransactionMode: 'terminal_buffered',
      replaceableDrafts: true,
    })).toBe(false);
  });

  it('只在旧 Run 恢复边界将 replaceableDrafts 映射为 replaceable_draft', () => {
    expect(resolveModelOutputTransactionMode({ replaceableDrafts: true })).toBe('replaceable_draft');
    expect(resolveModelOutputTransactionMode(undefined)).toBe('irreversible_stream');
  });
});
