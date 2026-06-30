import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveAuthorizedPath,
  sanitizeUserOverrides,
} from '../security/extraDirs.js';

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'extra-dirs-test-'));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe('extraDirs security helpers', () => {
  it('normalizes, de-duplicates, and preserves safe extraDirs', () => {
    const root = makeTempRoot();
    const safeDir = join(root, 'safe');
    mkdirSync(safeDir, { recursive: true });

    const sanitized = sanitizeUserOverrides(
      {
        zengky: {
          extraDirs: [`${safeDir}/`, safeDir],
        },
      },
      {
        processCwd: join(root, 'agent-app'),
        globalAgentCwd: join(root, 'workspace'),
      },
    );

    expect(sanitized?.zengky?.extraDirs).toEqual([safeDir]);
  });

  it('preserves non-path user override flags when sanitizing', () => {
    const root = makeTempRoot();
    const safeDir = join(root, 'safe');
    mkdirSync(safeDir, { recursive: true });

    const sanitized = sanitizeUserOverrides(
      {
        zengky: {
          extraDirs: [safeDir],
          allowGhCli: true,
        },
      },
      {
        processCwd: join(root, 'agent-app'),
        globalAgentCwd: join(root, 'workspace'),
      },
    );

    expect(sanitized?.zengky?.extraDirs).toEqual([safeDir]);
    expect(sanitized?.zengky?.allowGhCli).toBe(true);
  });

  it('rejects overlaps with protected roots', () => {
    const root = makeTempRoot();
    const workspaceRoot = join(root, 'workspace');
    mkdirSync(workspaceRoot, { recursive: true });

    expect(() => sanitizeUserOverrides(
      {
        zengky: {
          extraDirs: [workspaceRoot],
        },
      },
      {
        processCwd: join(root, 'agent-app'),
        globalAgentCwd: workspaceRoot,
      },
    )).toThrow(/protected path overlap/i);
  });

  it('resolves symlink targets before validating', () => {
    const root = makeTempRoot();
    const workspaceRoot = join(root, 'workspace');
    const safeDir = join(root, 'safe');
    const aliasDir = join(root, 'safe-link');
    mkdirSync(workspaceRoot, { recursive: true });
    mkdirSync(safeDir, { recursive: true });
    symlinkSync(safeDir, aliasDir);

    const sanitized = sanitizeUserOverrides(
      {
        zengky: {
          extraDirs: [aliasDir],
        },
      },
      {
        processCwd: join(root, 'agent-app'),
        globalAgentCwd: workspaceRoot,
      },
    );

    expect(sanitized?.zengky?.extraDirs).toEqual([realpathSync(safeDir)]);
  });

  it('rejects non-directory entries', () => {
    const root = makeTempRoot();
    const filePath = join(root, 'not-a-dir.txt');
    writeFileSync(filePath, 'x', 'utf-8');

    expect(() => sanitizeUserOverrides(
      {
        zengky: {
          extraDirs: [filePath],
        },
      },
      {
        processCwd: join(root, 'agent-app'),
        globalAgentCwd: join(root, 'workspace'),
      },
    )).toThrow(/must point to a directory/i);
  });

  it('allows relative workspace paths and absolute extraDir paths, but blocks outsiders', () => {
    const root = makeTempRoot();
    const userCwd = join(root, 'workspace', 'zengky');
    const extraDir = join(root, 'safe');
    mkdirSync(join(userCwd, 'docs'), { recursive: true });
    mkdirSync(extraDir, { recursive: true });

    expect(resolveAuthorizedPath('docs/a.md', userCwd, [extraDir])).toBe(join(userCwd, 'docs', 'a.md'));
    expect(resolveAuthorizedPath(join(extraDir, 'report.md'), userCwd, [extraDir])).toBe(join(extraDir, 'report.md'));
    expect(resolveAuthorizedPath(join(root, 'elsewhere.txt'), userCwd, [extraDir])).toBeNull();
  });
});
