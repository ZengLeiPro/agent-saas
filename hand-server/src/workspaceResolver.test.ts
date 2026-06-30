import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { WorkspaceResolver } from './workspaceResolver.js';

describe('WorkspaceResolver lifecycle', () => {
  const cleanupRoots: string[] = [];

  afterEach(async () => {
    for (const dir of cleanupRoots) {
      await rm(dir, { recursive: true, force: true });
    }
    cleanupRoots.length = 0;
  });

  async function createResolver(): Promise<{ root: string; resolver: WorkspaceResolver }> {
    const root = await mkdtemp(join(tmpdir(), 'hand-workspace-lifecycle-'));
    cleanupRoots.push(root);
    return { root, resolver: new WorkspaceResolver(root, { mode: 0o770 }) };
  }

  it('archives a workspace by renaming it under .archive without deleting files', async () => {
    const { root, resolver } = await createResolver();
    const workspacePath = await resolver.resolveAndEnsure('ws_kaiyan__user-1');
    await writeFile(join(workspacePath, 'note.txt'), 'KEEP_ME', 'utf8');

    const result = await resolver.archive('ws_kaiyan__user-1', 'reset-test');

    expect(result.archived).toBe(true);
    expect(result.archiveId).toContain('ws_kaiyan__user-1__');
    await expect(stat(workspacePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(root, '.archive', result.archiveId!, 'note.txt'), 'utf8')).resolves.toBe('KEEP_ME');
  });

  it('returns missing=true when archiving a non-existent workspace', async () => {
    const { resolver } = await createResolver();

    await expect(resolver.archive('ws_missing', 'manual')).resolves.toMatchObject({
      workspaceId: 'ws_missing',
      archived: false,
      missing: true,
    });
  });

  it('rejects private archive dir and path traversal as workspace ids', async () => {
    const { resolver } = await createResolver();

    await expect(resolver.resolveAndEnsure('.archive')).rejects.toThrow(/workspace\.id 非法/);
    await expect(resolver.resolveAndEnsure('../other')).rejects.toThrow(/workspace\.id 非法/);
  });
});
