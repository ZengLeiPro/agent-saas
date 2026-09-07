import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { securityHeaders, contentSecurityPolicyForEnv } from './securityHeaders.js';

describe('部署环境 Shell 安全头', () => {
  it.each([
    ['prod', 'https://agent.kaiyan.net'],
    ['staging', 'https://staging-agent.kaiyan.net'],
  ] as const)('%s 响应仅允许精确 Shell', async (env, origin) => {
    const app = new Hono();
    app.use('*', securityHeaders({ env }));
    app.get('/', (c) => c.html('<html></html>'));
    const res = await app.request('/');
    expect(res.headers.get('content-security-policy')?.split(';')[0]).toBe(
      `frame-ancestors ${origin}`,
    );
    expect(res.headers.get('x-frame-options')).toBeNull();
    expect(res.headers.get('strict-transport-security')).toContain('max-age=');
  });
  it.each([
    '*',
    'https://agent.kaiyan.net',
    'https://staging-agent.kaiyan.net http://localhost:1234',
  ])('Staging 拒绝覆盖为 %s', (origin) => {
    expect(() =>
      securityHeaders({ env: 'staging', contentSecurityPolicy: `frame-ancestors ${origin}` }),
    ).toThrow();
  });
  it('拒绝重复 frame-ancestors', () => {
    expect(() =>
      securityHeaders({
        env: 'staging',
        contentSecurityPolicy: `${contentSecurityPolicyForEnv('staging')}; frame-ancestors *`,
      }),
    ).toThrow();
  });
});
