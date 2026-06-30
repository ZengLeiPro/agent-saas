import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildRuntimePath,
  ensurePythonEnv,
  pipInstallArgs,
  pruneVenvArchive,
  toolNameForLocalProvider,
  venvRebuildReasons,
} from './sandboxRunner.js';

describe('toolNameForLocalProvider', () => {
  it('accepts legacy tool names from the deployed orchestrator compatibility layer', () => {
    expect(toolNameForLocalProvider('read_file')).toBe('Read');
    expect(toolNameForLocalProvider('write_file')).toBe('Write');
    expect(toolNameForLocalProvider('list_files')).toBe('List');
    expect(toolNameForLocalProvider('run_shell')).toBe('Shell');
  });

  it('keeps current workspace tool names unchanged', () => {
    expect(toolNameForLocalProvider('Read')).toBe('Read');
    expect(toolNameForLocalProvider('Edit')).toBe('Edit');
    expect(toolNameForLocalProvider('Glob')).toBe('Glob');
    expect(toolNameForLocalProvider('Grep')).toBe('Grep');
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
  });

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
