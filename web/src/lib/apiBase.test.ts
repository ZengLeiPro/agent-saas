import { describe, expect, it, vi } from 'vitest';

// 模拟分域部署：VITE_API_BASE 注入了独立 API 域
vi.mock('../platform/webConfig', () => ({
  webConfig: {
    platform: 'web',
    getBaseUrl: () => 'https://api.example.com',
    getWsUrl: () => '',
  },
}));

import { agentAvatarUrl, apiUrl, resolveApiAssetUrl } from './apiBase';

describe('apiUrl', () => {
  it('拼接分域 base', () => {
    expect(apiUrl('/api/healthz')).toBe('https://api.example.com/api/healthz');
  });
});

describe('resolveApiAssetUrl（分域 img src 收口）', () => {
  it('server 返回的相对 /api 资源路径转为绝对 URL', () => {
    expect(resolveApiAssetUrl('/api/auth/avatar/u1?v=2'))
      .toBe('https://api.example.com/api/auth/avatar/u1?v=2');
  });

  it('blob:/data:/绝对 URL 原样返回', () => {
    expect(resolveApiAssetUrl('blob:https://x/y')).toBe('blob:https://x/y');
    expect(resolveApiAssetUrl('data:image/png;base64,AAA')).toBe('data:image/png;base64,AAA');
    expect(resolveApiAssetUrl('https://cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png');
  });

  it('空值原样返回', () => {
    expect(resolveApiAssetUrl(undefined)).toBeUndefined();
  });
});

describe('agentAvatarUrl（web 端自动注入分域 base）', () => {
  it('个人 Agent 图片头像走 API 域', () => {
    expect(agentAvatarUrl('alice', 'agent-avatars/alice.png', 3))
      .toBe('https://api.example.com/api/agents/avatar/alice?v=3');
  });

  it('企业专家头像走 org-agents 端点', () => {
    expect(agentAvatarUrl('org-agent:oa1', 'org-agent-avatars/oa1.png', 2))
      .toBe('https://api.example.com/api/org-agents/avatar/oa1?v=2');
  });

  it('emoji/空头像返回 null（由调用方走 emoji 分支）', () => {
    expect(agentAvatarUrl('alice', '🐱')).toBeNull();
    expect(agentAvatarUrl('alice', undefined)).toBeNull();
  });
});
