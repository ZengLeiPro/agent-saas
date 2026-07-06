import { access, chmod, lstat, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ensureWorkspaceRuntimeLayout } from '../workspace/permissions.js';

describe('workspace runtime layout', () => {
  const previousChown = process.env.KY_AGENT_WORKSPACE_CHOWN;

  afterEach(() => {
    if (previousChown === undefined) {
      delete process.env.KY_AGENT_WORKSPACE_CHOWN;
    } else {
      process.env.KY_AGENT_WORKSPACE_CHOWN = previousChown;
    }
  });

  it('creates the .ky-agent runtime namespace without creating .claude', async () => {
    process.env.KY_AGENT_WORKSPACE_CHOWN = '0';
    const root = await mkdtemp(join(tmpdir(), 'workspace-layout-'));
    try {
      ensureWorkspaceRuntimeLayout(root);

      await expect(access(join(root, '.ky-agent'), constants.R_OK | constants.W_OK)).resolves.toBeUndefined();
      await expect(access(join(root, '.ky-agent', 'runtime', 'browser-profile'), constants.R_OK | constants.W_OK)).resolves.toBeUndefined();
      await expect(access(join(root, 'uploads'), constants.R_OK | constants.W_OK)).resolves.toBeUndefined();
      await expect(access(join(root, 'memory'), constants.R_OK | constants.W_OK)).resolves.toBeUndefined();
      await expect(access(join(root, '.claude'))).rejects.toThrow();
      expect((await stat(join(root, '.ky-agent', 'runtime', 'browser-profile'))).mode & 0o777).toBe(0o700);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not mkdir through a legacy scripts symlink', async () => {
    process.env.KY_AGENT_WORKSPACE_CHOWN = '0';
    const root = await mkdtemp(join(tmpdir(), 'workspace-scripts-link-'));
    try {
      await mkdir(join(root, '.ky-agent'), { recursive: true });
      await symlink(join(root, 'missing-shared-scripts'), join(root, '.ky-agent', 'scripts'));

      ensureWorkspaceRuntimeLayout(root);

      expect((await lstat(join(root, '.ky-agent', 'scripts'))).isSymbolicLink()).toBe(true);
      await expect(access(join(root, '.ky-agent', 'runtime', 'browser-profile'))).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('migrates legacy browser profile into .ky-agent/runtime before creating a new profile', async () => {
    process.env.KY_AGENT_WORKSPACE_CHOWN = '0';
    const root = await mkdtemp(join(tmpdir(), 'workspace-browser-profile-'));
    try {
      await mkdir(join(root, '.browser-profile', 'Default'), { recursive: true });
      await writeFile(join(root, '.browser-profile', 'Default', 'Cookies'), 'session=1', 'utf-8');

      ensureWorkspaceRuntimeLayout(root);

      await expect(access(join(root, '.ky-agent', 'runtime', 'browser-profile', 'Default', 'Cookies'))).resolves.toBeUndefined();
      await expect(access(join(root, '.browser-profile'))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('migrates legacy workspace venv into .ky-agent/runtime/venv', async () => {
    process.env.KY_AGENT_WORKSPACE_CHOWN = '0';
    const root = await mkdtemp(join(tmpdir(), 'workspace-venv-'));
    try {
      await mkdir(join(root, '.venv', 'bin'), { recursive: true });
      await writeFile(join(root, '.venv', 'bin', 'python3'), '#!/bin/sh\n', 'utf-8');

      ensureWorkspaceRuntimeLayout(root);

      await expect(access(join(root, '.ky-agent', 'runtime', 'venv', 'bin', 'python3'))).resolves.toBeUndefined();
      await expect(access(join(root, '.venv'))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('repairs key file modes for writable user data', async () => {
    process.env.KY_AGENT_WORKSPACE_CHOWN = '0';
    const root = await mkdtemp(join(tmpdir(), 'workspace-file-modes-'));
    try {
      await writeFile(join(root, 'MEMORY.md'), '# Memory\n', 'utf-8');
      await chmod(join(root, 'MEMORY.md'), 0o444);

      ensureWorkspaceRuntimeLayout(root);

      expect((await stat(join(root, 'MEMORY.md'))).mode & 0o777).toBe(0o664);
      expect((await stat(join(root, 'uploads'))).mode & 0o777).toBe(0o775);
      expect((await stat(join(root, '.ky-agent', 'runtime'))).mode & 0o777).toBe(0o770);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
