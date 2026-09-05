import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  actorFromEnv,
  receiptRelativePath,
  serializeReceipt,
  writeReceiptAtomically,
  type AdminRunnerReceipt,
} from './receipt.js';

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function baseReceipt(overrides: Partial<AdminRunnerReceipt> = {}): AdminRunnerReceipt {
  return {
    schemaVersion: 1,
    kind: 'agent-saas-admin-runner-receipt',
    invocationId: '11111111-2222-4333-8444-555555555555',
    command: 'demo',
    environment: 'production',
    writeIntents: [],
    escalationFlags: [],
    argsSummary: { declaredFlags: [], otherFlagCount: 0, positionalCount: 0, inlineValueCount: 0 },
    targetOverrides: [],
    authorizationForwarded: false,
    actor: { source: 'process_env', user: 'ops', trusted: false },
    startedAt: '2026-09-05T07:00:00.000Z',
    result: 'started',
    ...overrides,
  };
}

describe('admin runner receipt', () => {
  it('derives actor from env and never marks it trusted', () => {
    expect(actorFromEnv({ USER: 'root', SUDO_USER: 'ops' })).toEqual({
      source: 'process_env',
      user: 'root',
      sudoUser: 'ops',
      trusted: false,
    });
    expect(actorFromEnv({})).toEqual({ source: 'process_env', trusted: false });
  });

  it('places receipts under <env>/<yyyymmdd>/<invocationId>.json', () => {
    expect(receiptRelativePath(baseReceipt())).toBe(
      join('production', '20260905', '11111111-2222-4333-8444-555555555555.json'),
    );
  });

  it('writes atomically with 0600 and replaces the started receipt with the terminal one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'admin-receipt-'));
    temps.push(dir);
    const started = baseReceipt();
    const path = await writeReceiptAtomically(dir, started);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ result: 'started' });
    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);
    const final = await writeReceiptAtomically(dir, {
      ...started,
      result: 'succeeded',
      exitCode: 0,
      finishedAt: '2026-09-05T07:00:05.000Z',
    });
    expect(final).toBe(path);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      result: 'succeeded',
      exitCode: 0,
    });
    const leftovers = (await readdir(join(dir, 'production', '20260905'))).filter((name) =>
      name.endsWith('.tmp'),
    );
    expect(leftovers).toEqual([]);
  });

  it('keeps the schema stable', () => {
    const json = JSON.parse(
      serializeReceipt(
        baseReceipt({
          result: 'rejected',
          errorCategory: 'unknown_command',
          errorDetail: 'command is not in the manifest',
          finishedAt: '2026-09-05T07:00:01.000Z',
        }),
      ),
    );
    expect(Object.keys(json).sort()).toEqual(
      [
        'actor',
        'argsSummary',
        'authorizationForwarded',
        'command',
        'environment',
        'errorCategory',
        'errorDetail',
        'escalationFlags',
        'finishedAt',
        'invocationId',
        'kind',
        'result',
        'schemaVersion',
        'startedAt',
        'targetOverrides',
        'writeIntents',
      ].sort(),
    );
    expect(json.schemaVersion).toBe(1);
    expect(json.kind).toBe('agent-saas-admin-runner-receipt');
  });

  it('refuses to serialise credential-shaped content or absolute paths', () => {
    expect(() =>
      serializeReceipt(baseReceipt({ errorDetail: 'postgres://user:secret@db.internal/app' })),
    ).toThrow(/credential-shaped/u);
    expect(() =>
      serializeReceipt(baseReceipt({ errorDetail: 'Bearer abcdefghijklmnopqrstuvwxyz' })),
    ).toThrow(/credential-shaped/u);
    expect(() =>
      serializeReceipt(baseReceipt({ errorDetail: 'read /etc/agent-saas/config.json' })),
    ).toThrow(/absolute filesystem path/u);
    expect(() => serializeReceipt(baseReceipt({ authorizationRef: 'ref/Users/admin/x' }))).toThrow(
      /absolute filesystem path/u,
    );
  });

  it('refuses to write when the receipt directory resolves into the forbidden release root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'admin-receipt-symlink-'));
    temps.push(root);
    const release = join(root, 'release', 'server');
    await mkdir(release, { recursive: true });
    const outside = join(root, 'receipts');
    await symlink(release, outside);
    const forbiddenRealRoot = await realpath(release);
    await expect(
      writeReceiptAtomically(outside, baseReceipt(), undefined, { forbiddenRealRoot }),
    ).rejects.toThrow(/inside the sealed release directory/u);
    await expect(readdir(release)).resolves.not.toContain('production');
    const legit = join(root, 'legit');
    await expect(
      writeReceiptAtomically(legit, baseReceipt(), undefined, { forbiddenRealRoot }),
    ).resolves.toMatch(/\.json$/u);
  });

  it('does not write anything when serialisation is refused', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'admin-receipt-refused-'));
    temps.push(dir);
    await expect(
      writeReceiptAtomically(
        dir,
        baseReceipt({ errorDetail: 'token sk-abcdefghijklmnopqrstuvwxyz' }),
      ),
    ).rejects.toThrow(/credential-shaped/u);
    await expect(readdir(dir)).resolves.toEqual([]);
  });
});
