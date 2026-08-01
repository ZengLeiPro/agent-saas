import { describe, expect, it } from 'vitest';

import { HAND_ENV_ALLOWLIST, isHandEnvAllowed, pickHandEnv } from '../runtime/handEnvAllowlist.js';

describe('handEnvAllowlist', () => {
  it('历史变量与连接器标准 env 均允许透传', () => {
    expect(HAND_ENV_ALLOWLIST).toContain('AZEROTH_TOKEN');
    expect(HAND_ENV_ALLOWLIST).toContain('AZEROTH_API_URL');
    for (const key of [
      'AZEROTH_TOKEN', 'AZEROTH_API_URL', 'GH_TOKEN', 'GITHUB_TOKEN',
      'NOTION_API_TOKEN', 'GOOGLE_WORKSPACE_CLI_TOKEN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
    ]) {
      expect(isHandEnvAllowed(key)).toBe(true);
    }
  });

  it('拒绝非法名称与能改变进程加载行为的保留 env', () => {
    for (const key of [
      'PATH', 'HOME', 'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD',
      'PYTHONPATH', 'lowercase', 'BAD-NAME',
    ]) {
      expect(isHandEnvAllowed(key)).toBe(false);
    }
  });

  it('pickHandEnv 保留标准连接器 env 并剔除保留 key', () => {
    expect(pickHandEnv({
      AZEROTH_TOKEN: 'pat_x',
      GH_TOKEN: 'gh_x',
      NOTION_API_TOKEN: 'notion_x',
      GOOGLE_WORKSPACE_CLI_TOKEN: 'google_x',
      PATH: '/tmp/evil',
      NODE_OPTIONS: '--require /tmp/evil.js',
    })).toEqual({
      AZEROTH_TOKEN: 'pat_x',
      GH_TOKEN: 'gh_x',
      NOTION_API_TOKEN: 'notion_x',
      GOOGLE_WORKSPACE_CLI_TOKEN: 'google_x',
    });
  });

  it('pickHandEnv 剔除 undefined 和空字符串', () => {
    expect(pickHandEnv({
      AZEROTH_TOKEN: undefined,
      AZEROTH_API_URL: '',
    })).toEqual({});
  });

  it('只为 Git credential.helper 控制项保留必要空值', () => {
    expect(pickHandEnv({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      GH_TOKEN: '',
      GIT_CONFIG_KEY_1: 'user.name',
      GIT_CONFIG_VALUE_1: '',
    })).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'user.name',
    });
  });

  it('pickHandEnv 输入为空 / null / undefined 返回空对象', () => {
    expect(pickHandEnv(null)).toEqual({});
    expect(pickHandEnv(undefined)).toEqual({});
    expect(pickHandEnv({})).toEqual({});
  });
});
