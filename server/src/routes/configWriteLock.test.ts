import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ConfigWriteConflictError,
  publishConfigIfUnchanged,
  writeConfigIfUnchanged,
} from './configWriteLock.js';

const roots: string[] = [];

function configFixture(): { root: string; path: string; text: string } {
  const root = mkdtempSync(join(tmpdir(), 'config-write-lock-'));
  roots.push(root);
  const path = join(root, 'config.json');
  const text = '{"version":"old"}\n';
  writeFileSync(path, text, { encoding: 'utf8', mode: 0o600 });
  return { root, path, text };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('config write lock', () => {
  it('原子替换配置并保留权限，不留下临时文件', () => {
    const fixture = configFixture();
    const updated = '{"version":"new"}\n';

    writeConfigIfUnchanged(fixture.path, fixture.text, updated);

    expect(readFileSync(fixture.path, 'utf8')).toBe(updated);
    expect(statSync(fixture.path).mode & 0o777).toBe(0o600);
    expect(readdirSync(fixture.root)).toEqual(['config.json']);
  });

  it('替换失败时回滚执行侧且保持旧磁盘快照', async () => {
    const fixture = configFixture();
    let executionVersion = 'old';

    await expect(publishConfigIfUnchanged(
      fixture.path,
      fixture.text,
      '{"version":"candidate"}\n',
      () => { executionVersion = 'candidate'; },
      () => { executionVersion = 'old'; },
      () => { throw new Error('simulated atomic rename failure'); },
    )).rejects.toThrow('simulated atomic rename failure');

    expect(executionVersion).toBe('old');
    expect(readFileSync(fixture.path, 'utf8')).toBe(fixture.text);
    expect(readdirSync(fixture.root)).toEqual(['config.json']);
  });

  it('CAS 冲突不会调用执行侧或覆盖胜出版本', async () => {
    const fixture = configFixture();
    writeFileSync(fixture.path, '{"version":"winner"}\n', 'utf8');
    let applied = false;

    await expect(publishConfigIfUnchanged(
      fixture.path,
      fixture.text,
      '{"version":"candidate"}\n',
      () => { applied = true; },
    )).rejects.toBeInstanceOf(ConfigWriteConflictError);

    expect(applied).toBe(false);
    expect(readFileSync(fixture.path, 'utf8')).toBe('{"version":"winner"}\n');
  });
});
