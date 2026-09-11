import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildLocalConfig,
  deriveDatabaseName,
  parseJsoncConfig,
  parseWorktreeList,
  resolveSourceConfig,
} from './local-worktree-bootstrap.mjs';

describe('local worktree bootstrap', () => {
  it('为不同 worktree 生成稳定且合法的隔离数据库名', () => {
    const first = deriveDatabaseName('/tmp/agent-saas-feature-a');
    assert.match(first, /^[a-z][a-z0-9_]{0,62}$/);
    assert.equal(first, deriveDatabaseName('/tmp/agent-saas-feature-a'));
    assert.notEqual(first, deriveDatabaseName('/tmp/agent-saas-feature-b'));
  });

  it('解析 git worktree porcelain 输出', () => {
    assert.deepEqual(
      parseWorktreeList(
        [
          'worktree /repo/main',
          'HEAD abc',
          'branch refs/heads/main',
          '',
          'worktree /repo/feature',
          'HEAD def',
          'detached',
          '',
        ].join('\n'),
      ),
      [{ path: '/repo/main', branch: 'refs/heads/main' }, { path: '/repo/feature' }],
    );
  });

  it('JSONC 配置可解析并被校准为本地治理环境', () => {
    const source = parseJsoncConfig('{ "auth": { "enabled": false }, /* comment */ }', 'fixture');
    const config = buildLocalConfig(source, {
      connectionString: 'postgresql://local:test@127.0.0.1:5432/worktree',
      root: '/repo/feature',
    });
    assert.equal(config.server.port, 3200);
    assert.equal(config.auth.enabled, true);
    assert.ok(config.auth.jwtSecret.length >= 32);
    assert.equal(config.cron.enabled, false);
    assert.equal(config.runtimeEventStore.backend, 'pg');
    assert.equal(config.runtimeEventStore.writerCapability.capability, 'tenant-native-v1');
  });

  it('显式源配置不存在时拒绝静默回退', () => {
    assert.throws(
      () =>
        resolveSourceConfig({
          explicitPath: '/definitely/missing/config.json',
          root: '/definitely/missing/root',
          worktreeOutput: '',
        }),
      /指定的源配置不存在/,
    );
  });
});
