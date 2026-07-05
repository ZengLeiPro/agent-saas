import { describe, expect, it } from 'vitest';

import { HAND_ENV_ALLOWLIST, isHandEnvAllowed, pickHandEnv } from '../runtime/handEnvAllowlist.js';

describe('handEnvAllowlist', () => {
  it('AZEROTH_TOKEN + AZEROTH_API_URL 在 allowlist 内', () => {
    expect(HAND_ENV_ALLOWLIST).toContain('AZEROTH_TOKEN');
    expect(HAND_ENV_ALLOWLIST).toContain('AZEROTH_API_URL');
    expect(isHandEnvAllowed('AZEROTH_TOKEN')).toBe(true);
    expect(isHandEnvAllowed('AZEROTH_API_URL')).toBe(true);
  });

  it('拒绝其他敏感 env（防止 API key/TOKEN 走 wire 泄漏）', () => {
    for (const key of [
      'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY',
      'DASHSCOPE_API_KEY', 'ARK_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN',
      'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'FOO_TOKEN',
    ]) {
      expect(isHandEnvAllowed(key)).toBe(false);
    }
  });

  it('pickHandEnv 只保留 allowlist 内的 key', () => {
    expect(pickHandEnv({
      AZEROTH_TOKEN: 'pat_x',
      AZEROTH_API_URL: 'https://a',
      ANTHROPIC_API_KEY: 'sk-ant',
      RANDOM_ENV: 'noise',
    })).toEqual({
      AZEROTH_TOKEN: 'pat_x',
      AZEROTH_API_URL: 'https://a',
    });
  });

  it('pickHandEnv 剔除 undefined 和空字符串', () => {
    expect(pickHandEnv({
      AZEROTH_TOKEN: undefined,
      AZEROTH_API_URL: '',
    })).toEqual({});
  });

  it('pickHandEnv 输入为空 / null / undefined 返回空对象', () => {
    expect(pickHandEnv(null)).toEqual({});
    expect(pickHandEnv(undefined)).toEqual({});
    expect(pickHandEnv({})).toEqual({});
  });
});
