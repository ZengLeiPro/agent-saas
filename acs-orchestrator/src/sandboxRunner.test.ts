import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  addSnapshotMetadata,
  buildRuntimePath,
  ensurePythonEnv,
  executeFeishuCli,
  pipInstallArgs,
  pruneVenvArchive,
  normalizeShellCommandForCwd,
  toolNameForLocalProvider,
  venvRebuildReasons,
} from './sandboxRunner.js';

describe('Shell cwd command normalization', () => {
  it('removes only a redundant leading cd while preserving a Bash prelude', () => {
    expect(normalizeShellCommandForCwd('cd code/agent-saas && pnpm test', 'code/agent-saas')).toBe('pnpm test');
    expect(normalizeShellCommandForCwd('set -e\ncd "code/agent-saas" && pnpm test', 'code/agent-saas'))
      .toBe('set -e\npnpm test');
    expect(normalizeShellCommandForCwd('cd code/other && pnpm test', 'code/agent-saas'))
      .toBe('cd code/other && pnpm test');
  });
});

describe('snapshot result metadata', () => {
  it('flattens successful snapshot execution facts for the Agent', () => {
    const response = addSnapshotMetadata({
      status: 'error',
      error: 'command failed',
      metadata: { durationMs: 123 },
    }, {
      requested: 'snapshot',
      used: 'snapshot',
      repositoryPath: 'code/agent-saas',
      sourceCwd: '.',
      preparationMs: 44,
    });
    expect(response.status).toBe('error');
    if (response.status !== 'error') throw new Error('expected error response');
    expect(response.error).toContain('容器临时盘快照');
    expect(response.metadata).toMatchObject({
      executionRequested: 'snapshot',
      executionUsed: 'snapshot',
      executionTotalMs: 167,
      snapshotRepositoryPath: 'code/agent-saas',
    });
  });
});

describe('__FeishuCli internal tool', () => {
  it('rejects unknown operations and malformed sensitive inputs before spawning CLI', () => {
    expect(executeFeishuCli({ operation: 'shell', profile: 'kaiyan-agent' }, '/workspace')).toEqual({
      status: 'error',
      error: '不支持的飞书 CLI 内部操作',
    });
    expect(executeFeishuCli({
      operation: 'init',
      profile: 'kaiyan-agent',
      appId: 'cli_test',
      appSecret: 'secret\nleak',
    }, '/workspace')).toMatchObject({ status: 'error', error: expect.stringContaining('appSecret') });
    expect(executeFeishuCli({
      operation: 'complete_auth',
      profile: 'kaiyan-agent',
      deviceCode: 'bad code;echo leak',
    }, '/workspace')).toMatchObject({ status: 'error', error: expect.stringContaining('deviceCode') });
  });
});

describe('toolNameForLocalProvider', () => {
  it('accepts legacy tool names from the deployed orchestrator compatibility layer', () => {
    expect(toolNameForLocalProvider('read_file')).toBe('Read');
    expect(toolNameForLocalProvider('write_file')).toBe('Write');
    expect(toolNameForLocalProvider('run_shell')).toBe('Shell');
  });

  it('keeps current workspace tool names unchanged', () => {
    expect(toolNameForLocalProvider('Read')).toBe('Read');
    expect(toolNameForLocalProvider('Edit')).toBe('Edit');
    expect(toolNameForLocalProvider('Shell')).toBe('Shell');
  });
});

describe('ensurePythonEnv', () => {
  it('creates a workspace runtime venv manifest and reuses it when the contract matches', () => {
    const root = mkdtempSync(join(tmpdir(), 'acs-python-env-'));
    const requirementsPath = join(root, 'base.txt');
    writeFileSync(requirementsPath, '# empty in test\n');
    const originalEnv = { ...process.env };
    try {
      const first = ensurePythonEnv(root, {
        baseRequirementsPath: requirementsPath,
        imageRef: 'registry.example.com/agent-saas/acs-sandbox:test',
        skipBaseInstall: true,
        now: () => new Date('2026-06-29T00:00:00.000Z'),
      });
      expect(first.rebuilt).toBe(true);
      expect(first.venvPath).toBe(join(root, '.ky-agent', 'runtime', 'venv'));
      expect(process.env.VIRTUAL_ENV).toBe(first.venvPath);
      expect(process.env.PIP_CACHE_DIR).toBe(join(root, '.ky-agent', 'runtime', 'cache', 'pip'));
      expect(process.env.PATH?.split(':').slice(0, 4)).toEqual([
        join(first.venvPath, 'bin'),
        '/home/agent/.npm-global/bin',
        '/usr/local/bin',
        '/usr/local/sbin',
      ]);

      const manifest = JSON.parse(readFileSync(first.manifestPath, 'utf-8')) as Record<string, unknown>;
      expect(manifest).toMatchObject({
        contractVersion: 1,
        imageRef: 'registry.example.com/agent-saas/acs-sandbox:test',
        createdAt: '2026-06-29T00:00:00.000Z',
      });
      expect(typeof manifest.pythonMajorMinor).toBe('string');
      expect(typeof manifest.baseRequirementsHash).toBe('string');

      const second = ensurePythonEnv(root, {
        baseRequirementsPath: requirementsPath,
        imageRef: 'registry.example.com/agent-saas/acs-sandbox:test',
        skipBaseInstall: true,
      });
      expect(second.rebuilt).toBe(false);
      expect(second.rebuildReasons).toEqual([]);
    } finally {
      process.env = originalEnv;
    }
  }, 30_000);

  it('detects Python contract drift before reusing a venv', () => {
    const root = mkdtempSync(join(tmpdir(), 'acs-python-drift-'));
    const venvPath = join(root, '.ky-agent', 'runtime', 'venv');
    const binPath = join(venvPath, 'bin');
    mkdirSync(binPath, { recursive: true });
    writeFileSync(join(venvPath, 'pyvenv.cfg'), 'include-system-site-packages = false\n');
    const pythonPath = join(binPath, 'python3');
    writeFileSync(pythonPath, '#!/bin/sh\necho Python 3.14.5\n');
    chmodSync(pythonPath, 0o755);
    const manifestPath = join(venvPath, '.ky-runtime.json');
    writeFileSync(manifestPath, JSON.stringify({
      contractVersion: 1,
      pythonMajorMinor: '3.14',
      baseRequirementsHash: 'old-hash',
      imageRef: 'old-image',
      createdAt: '2026-06-29T00:00:00.000Z',
    }));

    expect(venvRebuildReasons({
      venvPath,
      pythonPath,
      manifestPath,
      desired: {
        contractVersion: 1,
        pythonMajorMinor: '3.14',
        baseRequirementsHash: 'new-hash',
        imageRef: 'new-image',
      },
    })).toEqual(['base-requirements-changed', 'image-ref-changed']);

    writeFileSync(join(venvPath, 'pyvenv.cfg'), 'include-system-site-packages = true\n');
    expect(venvRebuildReasons({
      venvPath,
      pythonPath,
      manifestPath,
      desired: {
        contractVersion: 1,
        pythonMajorMinor: '3.15',
        baseRequirementsHash: 'old-hash',
        imageRef: 'old-image',
      },
    })).toEqual(['venv-not-isolated', 'python-version-changed']);
  });

  // ── 2026-08-01 生产事故回归：venv rebuild 跨进程锁 ──
  // 并发 runner 同时 rebuild 互踩（File exists / ensurepip 半成品 / pip 文件被
  // archive 走），残缺 venv 让每个后续 runner 再触发 rebuild，自激循环。

  it('rebuild 锁被他人持有、等待期间 venv 恢复健康 → 直接复用不重建', () => {
    const root = mkdtempSync(join(tmpdir(), 'acs-venv-lock-heal-'));
    const requirementsPath = join(root, 'base.txt');
    writeFileSync(requirementsPath, '# empty in test\n');
    const originalEnv = { ...process.env };
    try {
      const opts = {
        baseRequirementsPath: requirementsPath,
        imageRef: 'registry.example.com/agent-saas/acs-sandbox:test',
        skipBaseInstall: true,
      };
      const first = ensurePythonEnv(root, opts);
      expect(first.rebuilt).toBe(true);
      const manifestBackup = readFileSync(first.manifestPath, 'utf-8');

      // 制造「他人正在 rebuild」现场：manifest 缺失 + 锁被持有
      const lockDir = join(root, '.ky-agent', 'runtime', 'venv-rebuild.lock');
      mkdirSync(lockDir);
      writeFileSync(join(root, 'manifest.bak'), manifestBackup);
      const restorer = spawn('/bin/sh', ['-c', `sleep 1 && cp ${JSON.stringify(join(root, 'manifest.bak'))} ${JSON.stringify(first.manifestPath)} && rm -rf ${JSON.stringify(lockDir)}`], { detached: false, stdio: 'ignore' });
      try {
        writeFileSync(first.manifestPath.replace(/\.ky-runtime\.json$/, '.tmp-del'), '');
        // 删 manifest 触发 rebuild 诱因
        writeFileSync(first.manifestPath, 'not-json');
        const result = ensurePythonEnv(root, { ...opts, rebuildLockWaitMs: 15_000 });
        // 等待期间 restorer 恢复了 manifest → 提前退出、零重建
        expect(result.rebuilt).toBe(false);
      } finally {
        restorer.kill();
      }
    } finally {
      process.env = originalEnv;
    }
  }, 30_000);

  it('stale 锁（持有者已死）被抢占，rebuild 正常完成', () => {
    const root = mkdtempSync(join(tmpdir(), 'acs-venv-lock-stale-'));
    const requirementsPath = join(root, 'base.txt');
    writeFileSync(requirementsPath, '# empty in test\n');
    const originalEnv = { ...process.env };
    try {
      const lockDir = join(root, '.ky-agent', 'runtime', 'venv-rebuild.lock');
      mkdirSync(lockDir, { recursive: true });
      const staleTime = new Date(Date.now() - 60 * 60_000);
      utimesSync(lockDir, staleTime, staleTime);

      const result = ensurePythonEnv(root, {
        baseRequirementsPath: requirementsPath,
        imageRef: 'registry.example.com/agent-saas/acs-sandbox:test',
        skipBaseInstall: true,
        rebuildLockWaitMs: 15_000,
        rebuildLockStaleMs: 900_000,
      });
      expect(result.rebuilt).toBe(true);
      expect(existsSync(lockDir)).toBe(false);
    } finally {
      process.env = originalEnv;
    }
  }, 30_000);

  it('锁等待超时且 venv 仍不健康 → 明确报错而非带病并发重建', () => {
    const root = mkdtempSync(join(tmpdir(), 'acs-venv-lock-busy-'));
    const requirementsPath = join(root, 'base.txt');
    writeFileSync(requirementsPath, '# empty in test\n');
    const originalEnv = { ...process.env };
    try {
      const lockDir = join(root, '.ky-agent', 'runtime', 'venv-rebuild.lock');
      mkdirSync(lockDir, { recursive: true });

      expect(() => ensurePythonEnv(root, {
        baseRequirementsPath: requirementsPath,
        imageRef: 'registry.example.com/agent-saas/acs-sandbox:test',
        skipBaseInstall: true,
        rebuildLockWaitMs: 1_200,
        rebuildLockStaleMs: 900_000,
      })).toThrow(/venv rebuild lock busy/);
    } finally {
      process.env = originalEnv;
    }
  });
});

describe('buildRuntimePath', () => {
  it('pins venv, npm global and system sbin before inherited PATH entries without duplicates', () => {
    expect(buildRuntimePath('/workspace/.ky-agent/runtime/venv', '/usr/bin:/custom/bin:/usr/sbin')).toBe(
      '/workspace/.ky-agent/runtime/venv/bin:/home/agent/.npm-global/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin:/custom/bin',
    );
  });
});

describe('pipInstallArgs', () => {
  it('uses an image-local wheelhouse when available', () => {
    expect(pipInstallArgs('/app/requirements/base.txt', '/opt/ky-agent/python-wheels')).toEqual([
      '-m',
      'pip',
      'install',
      '--no-compile',
      '--no-index',
      '--find-links=/opt/ky-agent/python-wheels',
      '-r',
      '/app/requirements/base.txt',
    ]);
  });

  it('falls back to pip index when no wheelhouse is configured', () => {
    expect(pipInstallArgs('/app/requirements/base.txt')).toEqual([
      '-m',
      'pip',
      'install',
      '--no-compile',
      '-r',
      '/app/requirements/base.txt',
    ]);
  });
});

describe('pruneVenvArchive', () => {
  it('keeps the newest venv archives and ignores unrelated entries', () => {
    const root = mkdtempSync(join(tmpdir(), 'acs-venv-archive-'));
    const archiveRoot = join(root, '.ky-agent', 'runtime', 'venv-archive');
    mkdirSync(archiveRoot, { recursive: true });
    const entries = [
      { name: '.venv-old', date: new Date('2026-06-29T00:00:00.000Z') },
      { name: '.venv-mid', date: new Date('2026-06-30T00:00:00.000Z') },
      { name: '.venv-new', date: new Date('2026-07-01T00:00:00.000Z') },
    ];
    for (const entry of entries) {
      const path = join(archiveRoot, entry.name);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'marker.txt'), entry.name);
      utimesSync(path, entry.date, entry.date);
    }
    mkdirSync(join(archiveRoot, 'manual-backup'), { recursive: true });
    writeFileSync(join(archiveRoot, 'notes.txt'), 'keep');

    expect(pruneVenvArchive(archiveRoot, 2)).toEqual([join(archiveRoot, '.venv-old')]);
    expect(readdirSync(archiveRoot).sort()).toEqual(['.venv-mid', '.venv-new', 'manual-backup', 'notes.txt']);
    expect(existsSync(join(archiveRoot, 'manual-backup'))).toBe(true);
    expect(existsSync(join(archiveRoot, 'notes.txt'))).toBe(true);
  });
});
