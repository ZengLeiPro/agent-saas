import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyEdits, modify } from 'jsonc-parser';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AdminConfigMutationService,
  ConfigConflictError,
  configFingerprint,
} from '../config/adminConfigMutationService.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'admin-config-mutation-'));
  roots.push(root);
  await mkdir(join(root, 'data'));
  const configPath = join(root, 'config.json');
  const raw = {
    agent: { cwd: '/tmp/workspace', maxTurns: 20, permissionMode: 'default' },
    server: { port: 3000 },
  };
  await writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o640 });
  const service = new AdminConfigMutationService({
    configPath,
    processCwd: root,
    environment: 'staging',
    processRole: 'ws-only',
    now: () => new Date('2026-09-01T00:00:00.000Z'),
  });
  return { root, configPath, raw, service };
}

describe('AdminConfigMutationService', () => {
  it('atomically applies a validated update and records a redacted audit', async () => {
    const test = await fixture();
    const applyRuntime = vi.fn();
    const result = await test.service.mutate({
      actor: 'admin-1',
      changedPaths: ['agent.maxTurns'],
      expectedFingerprint: configFingerprint(test.raw),
      buildCandidate: (text) => applyEdits(text, modify(text, ['agent', 'maxTurns'], 30, {})),
      applyRuntime,
    });
    expect(result.config.agent.maxTurns).toBe(30);
    expect(applyRuntime).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(test.configPath, 'utf8')).agent.maxTurns).toBe(30);
    const audit = await readFile(join(test.root, 'data/config-governance/audit.jsonl'), 'utf8');
    expect(audit).toContain('"result":"applied"');
    expect(audit).toContain('agent.maxTurns');
    expect(await readdir(join(test.root, 'data/config-governance/backups'))).toHaveLength(1);
  });

  it('rejects a stale optimistic fingerprint without touching the file', async () => {
    const test = await fixture();
    await expect(
      test.service.mutate({
        actor: 'admin-1',
        changedPaths: ['agent.maxTurns'],
        expectedFingerprint: `sha256:${'0'.repeat(64)}`,
        buildCandidate: (text) => text,
        applyRuntime: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(ConfigConflictError);
    expect(JSON.parse(await readFile(test.configPath, 'utf8')).agent.maxTurns).toBe(20);
  });

  it('restores the previous file and runtime when apply fails', async () => {
    const test = await fixture();
    const applyRuntime = vi
      .fn()
      .mockRejectedValueOnce(new Error('runtime rejected candidate'))
      .mockResolvedValueOnce(undefined);
    await expect(
      test.service.mutate({
        actor: 'admin-1',
        changedPaths: ['agent.maxTurns'],
        buildCandidate: (text) => applyEdits(text, modify(text, ['agent', 'maxTurns'], 40, {})),
        applyRuntime,
      }),
    ).rejects.toThrow('runtime rejected candidate');
    expect(JSON.parse(await readFile(test.configPath, 'utf8')).agent.maxTurns).toBe(20);
    expect(applyRuntime).toHaveBeenCalledTimes(2);
    const audit = await readFile(join(test.root, 'data/config-governance/audit.jsonl'), 'utf8');
    expect(audit).toContain('"result":"rolled_back"');
  });
});
