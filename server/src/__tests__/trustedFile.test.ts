import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  UnsafeFilePathError,
  atomicWriteTrustedFile,
  copyTrustedFile,
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
  it('binds every trusted-root ancestor and rejects an alias that escapes before the root', async () => {
    const { root, outside } = await fixture();
    const alias = join(root, '..', 'alias');
    const escapedRoot = join(outside, 'root');
    await mkdir(escapedRoot);
    await writeFile(join(escapedRoot, 'secret.txt'), 'escaped secret');
    await symlink(outside, alias);
    const aliasedRoot = join(alias, 'root');

    await expect(readTrustedFile(aliasedRoot, 'secret.txt', 'utf8')).rejects.toBeInstanceOf(UnsafeFilePathError);
    await expect(writeTrustedFile(aliasedRoot, 'new.txt', 'escaped')).rejects.toBeInstanceOf(UnsafeFilePathError);
    await expect(removeTrustedPath(aliasedRoot, 'secret.txt')).rejects.toBeInstanceOf(UnsafeFilePathError);
    await expect(readFile(join(escapedRoot, 'secret.txt'), 'utf8')).resolves.toBe('escaped secret');
    await expect(readFile(join(escapedRoot, 'new.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    await expect(readTrustedFile(root, 'safe/nested/inside.txt', 'utf8')).resolves.toBe('inside');
    await writeTrustedFile(root, 'safe/nested/normal.txt', 'normal');
    await expect(readFile(join(root, 'safe', 'nested', 'normal.txt'), 'utf8')).resolves.toBe('normal');
    await removeTrustedPath(root, 'safe/nested/normal.txt');
    await expect(readFile(join(root, 'safe', 'nested', 'normal.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

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

  it('refuses an atomic update when the opened target path was replaced', async () => {
    const { root } = await fixture();
    const target = join(root, 'safe', 'nested', 'inside.txt');
    const original = join(root, 'safe', 'nested', 'inside-original.txt');
    const opened = await openTrustedFile(root, 'safe/nested/inside.txt');
    expect(await opened.handle.readFile('utf8')).toBe('inside');

    await rename(target, original);
    await writeFile(target, 'concurrent replacement');
    try {
      await expect(atomicWriteTrustedFile(root, 'safe/nested/inside.txt', 'edited', {
        expectedFile: opened.stats,
      })).rejects.toMatchObject({ code: 'ESTALE' });
    } finally {
      await opened.handle.close();
    }

    await expect(readFile(target, 'utf8')).resolves.toBe('concurrent replacement');
    await expect(readFile(original, 'utf8')).resolves.toBe('inside');
  });

  it('refuses an atomic update after same-inode content changed', async () => {
    const { root } = await fixture();
    const target = join(root, 'safe', 'nested', 'inside.txt');
    const opened = await openTrustedFile(root, 'safe/nested/inside.txt');
    await writeFile(target, 'concurrent update with another size');
    const changedStats = await stat(target);
    try {
      await expect(atomicWriteTrustedFile(root, 'safe/nested/inside.txt', 'edited', {
        expectedFile: changedStats,
        expectedContent: 'inside',
      })).rejects.toMatchObject({ code: 'ESTALE' });
    } finally {
      await opened.handle.close();
    }
    await expect(readFile(target, 'utf8')).resolves.toBe('concurrent update with another size');
  });

  it('applies the process umask to a newly created atomic target', async () => {
    const { root } = await fixture();
    const target = join(root, 'safe', 'nested', 'new.txt');
    await atomicWriteTrustedFile(root, 'safe/nested/new.txt', 'new');
    expect((await stat(target)).mode & 0o777).toBe(0o664 & ~process.umask());
  });

  it('rejects path separators in an atomic temp suffix', async () => {
    const { root } = await fixture();
    await expect(atomicWriteTrustedFile(root, 'safe/nested/inside.txt', 'edited', {
      tempSuffix: '../escape',
    })).rejects.toBeInstanceOf(UnsafeFilePathError);
    await expect(readFile(join(root, 'safe', 'nested', 'inside.txt'), 'utf8')).resolves.toBe('inside');
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

  it('closes the opened descriptor when openTrustedFile stat fails', async () => {
    const { root } = await fixture();
    const target = join(root, 'safe', 'nested', 'inside.txt');
    const probe = await open(target, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probe);
    await probe.close();
    const statError = Object.assign(new Error('stat failed'), { code: 'EIO' });
    const statSpy = vi.spyOn(fileHandlePrototype, 'stat').mockRejectedValue(statError);
    const descriptorCount = async () => (await readdir('/proc/self/fd')).length;
    const before = await descriptorCount();

    try {
      for (let attempt = 0; attempt < 32; attempt += 1) {
        await expect(openTrustedFile(root, 'safe/nested/inside.txt')).rejects.toBe(statError);
      }
    } finally {
      statSpy.mockRestore();
    }

    expect(await descriptorCount()).toBe(before);
  });

  it('closes the opened descriptor when removeTrustedPath file stat fails', async () => {
    const { root } = await fixture();
    const target = join(root, 'safe', 'nested', 'inside.txt');
    const probe = await open(target, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probe);
    await probe.close();
    const statError = Object.assign(new Error('stat failed'), { code: 'EIO' });
    const statSpy = vi.spyOn(fileHandlePrototype, 'stat').mockRejectedValue(statError);
    const descriptorCount = async () => (await readdir('/proc/self/fd')).length;
    const before = await descriptorCount();

    try {
      for (let attempt = 0; attempt < 32; attempt += 1) {
        await expect(removeTrustedPath(root, 'safe/nested/inside.txt')).rejects.toBe(statError);
      }
    } finally {
      statSpy.mockRestore();
    }

    expect(await descriptorCount()).toBe(before);
    await expect(readFile(target, 'utf8')).resolves.toBe('inside');
  });

  it('closes the source descriptor when destination-root binding fails', async () => {
    const { root, outside } = await fixture();
    const destinationAlias = join(root, '..', 'destination-alias');
    await symlink(outside, destinationAlias);
    const descriptorCount = async () => (await readdir('/proc/self/fd')).length;
    const before = await descriptorCount();

    for (let attempt = 0; attempt < 32; attempt += 1) {
      await expect(copyTrustedFile(root, 'safe/nested/inside.txt', destinationAlias, `copy-${attempt}.txt`))
        .rejects.toBeInstanceOf(UnsafeFilePathError);
    }

    expect(await descriptorCount()).toBe(before);
  });

  it('removes a partial destination when the source becomes shorter during copy', async () => {
    const { root } = await fixture();
    const probe = await open(join(root, 'safe', 'nested', 'inside.txt'), 'r');
    const readPrototype = Object.getPrototypeOf(probe);
    await probe.close();
    const readSpy = vi.spyOn(readPrototype, 'read').mockResolvedValueOnce({
      bytesRead: 0,
      buffer: Buffer.alloc(0),
    });
    try {
      await expect(copyTrustedFile(root, 'safe/nested/inside.txt', root, 'copy.txt'))
        .rejects.toMatchObject({ code: 'EIO' });
    } finally {
      readSpy.mockRestore();
    }
    await expect(readFile(join(root, 'copy.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('lets 64 concurrent writers create a new trusted root without EEXIST failures', async () => {
    const base = await mkdtemp(join(tmpdir(), 'trusted-file-new-root-'));
    roots.push(base);
    const root = join(base, 'root');
    const writes = Array.from({ length: 64 }, (_, index) =>
      writeTrustedFile(root, `file-${index}.txt`, `value-${index}`, { createParents: true }));

    await expect(Promise.all(writes)).resolves.toHaveLength(64);
    await expect(Promise.all(Array.from({ length: 64 }, (_, index) =>
      readFile(join(root, `file-${index}.txt`), 'utf8'))))
      .resolves.toEqual(Array.from({ length: 64 }, (_, index) => `value-${index}`));
  });

  it('lets 64 concurrent writers create new parent directories without EEXIST failures', async () => {
    const { root } = await fixture();
    const writes = Array.from({ length: 64 }, (_, index) =>
      writeTrustedFile(root, `concurrent/new-parent/file-${index}.txt`, `value-${index}`, { createParents: true }));

    await expect(Promise.all(writes)).resolves.toHaveLength(64);
    await expect(Promise.all(Array.from({ length: 64 }, (_, index) =>
      readFile(join(root, 'concurrent', 'new-parent', `file-${index}.txt`), 'utf8'))))
      .resolves.toEqual(Array.from({ length: 64 }, (_, index) => `value-${index}`));
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
