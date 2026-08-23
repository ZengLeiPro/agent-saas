import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  UnsafeFilePathError,
  openTrustedFile,
  readTrustedFile,
  relativeToTrustedRoot,
  removeTrustedPath,
  selectTrustedRoot,
  writeTrustedFile,
} from '../security/trustedFile.js';

const roots: string[] = [];

async function fixture(): Promise<{ root: string; outside: string }> {
  const base = await mkdtemp(join(tmpdir(), 'trusted-file-'));
  roots.push(base);
  const root = join(base, 'root');
  const outside = join(base, 'outside');
  await mkdir(join(root, 'safe', 'nested'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(root, 'safe', 'nested', 'inside.txt'), 'inside');
  await writeFile(join(outside, 'secret.txt'), 'secret');
  return { root, outside };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('trusted descriptor-relative file operations', () => {
  it('rejects a symlink in every ancestor for reads, writes, and deletes', async () => {
    const { root, outside } = await fixture();
    await symlink(outside, join(root, 'linked'));

    await expect(readTrustedFile(root, 'linked/secret.txt', 'utf8')).rejects.toBeInstanceOf(UnsafeFilePathError);
    await expect(writeTrustedFile(root, 'linked/new.txt', 'escaped')).rejects.toBeInstanceOf(UnsafeFilePathError);
    await expect(removeTrustedPath(root, 'linked/secret.txt')).rejects.toBeInstanceOf(UnsafeFilePathError);
    await expect(readFile(join(outside, 'secret.txt'), 'utf8')).resolves.toBe('secret');
    await expect(readFile(join(outside, 'new.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the opened inode bound when an ancestor is renamed and replaced by a symlink', async () => {
    const { root, outside } = await fixture();
    await writeFile(join(outside, 'inside.txt'), 'outside replacement');
    const opened = await openTrustedFile(root, 'safe/nested/inside.txt');

    await rename(join(root, 'safe'), join(root, 'safe-original'));
    await symlink(outside, join(root, 'safe'));
    try {
      await expect(opened.handle.readFile('utf8')).resolves.toBe('inside');
    } finally {
      await opened.handle.close();
    }
    await expect(readTrustedFile(root, 'safe/inside.txt', 'utf8')).rejects.toBeInstanceOf(UnsafeFilePathError);
  });

  it('rejects cross-root reads, writes, and deletes before filesystem I/O', async () => {
    const { root, outside } = await fixture();
    expect(() => relativeToTrustedRoot(root, join(outside, 'secret.txt'))).toThrow(UnsafeFilePathError);
    expect(() => selectTrustedRoot(join(outside, 'secret.txt'), [root])).toThrow(UnsafeFilePathError);
    await expect(readTrustedFile(root, '../outside/secret.txt', 'utf8')).rejects.toBeInstanceOf(UnsafeFilePathError);
    await expect(writeTrustedFile(root, '../outside/new.txt', 'escaped')).rejects.toBeInstanceOf(UnsafeFilePathError);
    await expect(removeTrustedPath(root, '../outside/secret.txt')).rejects.toBeInstanceOf(UnsafeFilePathError);
    await expect(readFile(join(outside, 'secret.txt'), 'utf8')).resolves.toBe('secret');
    await expect(readFile(join(outside, 'new.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('creates pinned parent directories and refuses a final symlink', async () => {
    const { root, outside } = await fixture();
    await writeTrustedFile(root, 'created/by/handle.txt', 'ok', { createParents: true });
    await expect(readFile(join(root, 'created', 'by', 'handle.txt'), 'utf8')).resolves.toBe('ok');

    await symlink(join(outside, 'secret.txt'), join(root, 'final-link.txt'));
    await expect(writeTrustedFile(root, 'final-link.txt', 'nope')).rejects.toBeInstanceOf(UnsafeFilePathError);
    await expect(readFile(join(outside, 'secret.txt'), 'utf8')).resolves.toBe('secret');
  });
});
