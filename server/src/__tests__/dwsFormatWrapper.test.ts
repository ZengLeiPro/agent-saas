/**
 * scripts/dws-format-wrapper.sh 行为契约（2026-08-03 方案 A）。
 *
 * 用 fake dws（echo argv）+ 受控 PATH 驱动真实 wrapper 脚本，逐分支断言：
 * 默认 disable、业务模块注入、已带 flag/help/version/`--` 直通、非白名单模块直通、
 * 真实 CLI 缺失时 127。与 Dockerfile 构建期 smoke 同一契约，此处覆盖全分支。
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const WRAPPER = resolve(process.cwd(), '../scripts/dws-format-wrapper.sh');

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function makeFakeCliDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dws-wrapper-'));
  roots.push(dir);
  const fake = join(dir, 'dws');
  writeFileSync(fake, '#!/bin/bash\necho "ARGS:$*"\n');
  chmodSync(fake, 0o755);
  return dir;
}

function runWrapper(args: string[], opts: { enable?: boolean; realDir?: string } = {}) {
  const realDir = opts.realDir ?? makeFakeCliDir();
  return spawnSync('/bin/bash', [WRAPPER, ...args], {
    encoding: 'utf8',
    timeout: 5_000,
    env: {
      // 与 Dockerfile 构建期 smoke 同构：PATH 只放 wrapper 和 fake CLI，
      // 防止 dirname 等未声明的系统工具依赖被开发机环境掩盖。
      PATH: `${resolve(WRAPPER, '..')}:${realDir}`,
      ...(opts.enable ? { KY_DWS_WRAPPER_ENABLE: '1' } : {}),
    },
  });
}

describe('dws format wrapper', () => {
  it('默认（未启用）直通，不注入', () => {
    const r = runWrapper(['todo', 'task', 'create', '--title', 'x']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('ARGS:todo task create --title x');
  });

  it('启用后对业务模块追加 --format json', () => {
    const r = runWrapper(['todo', 'task', 'create', '--title', 'x'], { enable: true });
    expect(r.stdout.trim()).toBe('ARGS:todo task create --title x --format json');
  });

  it('启用后 calendar 等其他白名单模块同样注入', () => {
    const r = runWrapper(['calendar', 'event', 'list'], { enable: true });
    expect(r.stdout.trim()).toBe('ARGS:calendar event list --format json');
  });

  it('已带 --format 时直通（尊重模型显式选择）', () => {
    const r = runWrapper(['todo', 'task', 'list', '--format', 'table'], { enable: true });
    expect(r.stdout.trim()).toBe('ARGS:todo task list --format table');
  });

  it('已带 -f 短参时直通', () => {
    const r = runWrapper(['todo', 'task', 'list', '-f', 'csv'], { enable: true });
    expect(r.stdout.trim()).toBe('ARGS:todo task list -f csv');
  });

  it('--help 直通不注入', () => {
    const r = runWrapper(['todo', 'task', 'create', '--help'], { enable: true });
    expect(r.stdout.trim()).toBe('ARGS:todo task create --help');
  });

  it('--version 直通不注入', () => {
    const r = runWrapper(['--version'], { enable: true });
    expect(r.stdout.trim()).toBe('ARGS:--version');
  });

  it('含 `--` terminator 时直通（追加会被吞成位置参数）', () => {
    const r = runWrapper(['todo', 'task', 'create', '--', 'literal'], { enable: true });
    expect(r.stdout.trim()).toBe('ARGS:todo task create -- literal');
  });

  it('非白名单模块（auth 诊断类）直通', () => {
    const r = runWrapper(['auth', 'status'], { enable: true });
    expect(r.stdout.trim()).toBe('ARGS:auth status');
  });

  it('global flag 值先于子命令时按宁漏勿错直通（值被当子命令 → 不在白名单）', () => {
    const r = runWrapper(['--timeout', '30', 'todo', 'task', 'list'], { enable: true });
    expect(r.stdout.trim()).toBe('ARGS:--timeout 30 todo task list');
  });

  it('PATH 上找不到真实 CLI 时报 127（语义与无 wrapper 一致）', () => {
    const empty = mkdtempSync(join(tmpdir(), 'dws-wrapper-empty-'));
    roots.push(empty);
    const r = runWrapper(['todo', 'task', 'list'], { enable: true, realDir: empty });
    expect(r.status).toBe(127);
    expect(r.stderr).toContain('command not found');
  });
});
