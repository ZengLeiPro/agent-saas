import { describe, expect, it } from 'vitest';

import { parseAppConfig } from '../app/config.js';
import type { AppConfig } from '../types/index.js';
import { buildCanonicalConfigProjection, calculateConfigIdentityDigest } from './configIdentity.js';

const BASE = {
  agent: { cwd: '/srv/agent', permissionMode: 'default' },
  server: { port: 3001, timezone: 'Asia/Shanghai' },
};

function projection(overrides: Record<string, unknown>) {
  const config = parseAppConfig({ ...BASE, ...overrides }) as AppConfig;
  return buildCanonicalConfigProjection(config).projection;
}

function digest(overrides: Record<string, unknown>): string {
  return calculateConfigIdentityDigest(projection(overrides));
}

const cases = [
  {
    name: 'auth.usersFile',
    config: (path: string) => ({
      auth: {
        enabled: true,
        jwtSecret: 'test-jwt-secret-at-least-thirty-two-characters',
        usersFile: path,
      },
    }),
  },
  {
    name: 'artifact.rootDir',
    config: (path: string) => ({ artifact: { backend: 'local', rootDir: path } }),
  },
  {
    name: 'memory.index.dbDir',
    config: (path: string) => ({
      memory: {
        index: {
          dbDir: path,
          embedding: {
            baseUrl: 'https://embedding.example.com',
            apiKeyRef: 'embedding-ref',
            model: 'embedding-model',
            dimensions: 1024,
          },
        },
      },
    }),
  },
] as const;

describe('ConfigIdentity 机器路径投影', () => {
  it('相对路径以不可逆 opaque digest 投影且不泄漏原值', () => {
    const serialized = JSON.stringify(projection(cases[1].config('./private/artifacts')));
    expect(serialized).not.toContain('./private/artifacts');
    expect(serialized).not.toContain('private/artifacts');
    expect(serialized).toContain('__opaqueDigest__');
  });

  for (const fixture of cases) {
    it(`${fixture.name} 排除绝对宿主机路径差异`, () => {
      expect(digest(fixture.config('/srv/host-a'))).toBe(digest(fixture.config('/var/lib/host-b')));
      expect(digest(fixture.config('C:\\host-a'))).toBe(digest(fixture.config('D:\\host-b')));
    });

    it(`${fixture.name} 规范化运行期等价的相对路径`, () => {
      const aliases = ['./data/source', 'data/source', 'data/cache/../source'];
      expect(new Set(aliases.map((path) => digest(fixture.config(path))))).toHaveLength(1);
    });

    it(`${fixture.name} 保留不同相对目标的行为变化`, () => {
      expect(digest(fixture.config('./data/source-a'))).not.toBe(
        digest(fixture.config('./data/source-b')),
      );
    });
  }
});
