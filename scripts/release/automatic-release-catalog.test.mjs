import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readRelease, loadCatalog } from './automatic-release-catalog.mjs';
import { createAttestationSnapshot } from './attestation-snapshot.mjs';
import { AutomaticGitHub } from './automatic-release-github.mjs';
import { release, sha } from './fixtures/automatic-release-fixture.mjs';

for (const mode of ['accepted', 'fork', 'wrong-manifest', 'invalid-json', 'symlink']) {
  test(`catalog uses actual bounded files and complete snapshot selection: ${mode}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'auto-catalog-'));
    const candidate = release(118, sha(10), sha(1));
    const client = {
      repository: 'owner/agent-saas',
      api: async () => ({ draft: false, tag_name: candidate.manifest.releaseId }),
      gh: async (args) => {
        const out = args[args.indexOf('--dir') + 1];
        const manifest = structuredClone(candidate.manifest);
        if (mode === 'wrong-manifest') manifest.releaseId = 'rc-20260911-119';
        await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest));
        const source = join(root, 'history.jsonl');
        await writeFile(source, candidate.history.map(JSON.stringify).join('\n') + '\n');
        const snapshot = await createAttestationSnapshot(source, out);
        if (mode === 'fork') {
          const entries = structuredClone(candidate.history);
          entries[0].reason = 'conflicting history';
          await writeFile(source, entries.map(JSON.stringify).join('\n') + '\n');
          await createAttestationSnapshot(source, out);
        }
        if (mode === 'invalid-json') await writeFile(snapshot.path, '{oops');
        if (mode === 'symlink') {
          const { symlink } = await import('node:fs/promises');
          await rm(snapshot.path);
          await symlink(source, snapshot.path);
        }
      },
    };
    try {
      const action = () => readRelease(client, candidate.manifest.releaseId, root);
      if (mode === 'accepted') {
        const result = await action();
        assert.equal(result.state, 'verified');
        assert.deepEqual(result.history, candidate.history);
        assert.equal(result.manifest.digest, candidate.manifest.digest);
      } else await assert.rejects(action);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
test('catalog ignores drafts without inventing evidence and reads every accepted RC', async () => {
  const calls = [];
  const client = {
    pages: async () => [
      { draft: true, tag_name: 'rc-20260911-118' },
      { draft: false, tag_name: 'v1.0' },
      { draft: false, tag_name: 'rc-20260911-119', assets: [] },
    ],
    api: async (...args) => calls.push(args),
  };
  assert.deepEqual(await loadCatalog(client, '/unused'), []);
  assert.equal(calls.length, 0);
});
test('GitHub client sends write JSON on stdin exactly once when its acknowledgement is lost', async () => {
  const calls = [];
  const client = new AutomaticGitHub('owner/agent-saas', {
    command: async (...args) => {
      calls.push(args);
      throw new Error('network disconnected');
    },
  });
  await assert.rejects(
    client.api('actions/workflows/promote-release.yml/dispatches', {
      ref: 'main',
      return_run_details: true,
      inputs: { reason: 'safe reason' },
    }),
    { code: 'write_acknowledgement_unknown' },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'gh');
  assert(calls[0][1].includes('--input'));
  assert.equal(JSON.parse(calls[0][2].input).return_run_details, true);
  assert(!calls[0][1].some((x) => x.includes('safe reason')));
});
test('GitHub client paginates completely and rejects truncated inventories', async () => {
  const calls = [];
  const client = new AutomaticGitHub('owner/agent-saas', {
    command: async (_file, args) => {
      calls.push(args);
      const first = new URLSearchParams(args[1].split('?')[1]).get('page') === '1';
      return {
        stdout: JSON.stringify({
          total_count: 101,
          workflow_runs: Array.from({ length: first ? 100 : 1 }, (_, id) => ({ id })),
        }),
      };
    },
  });
  assert.equal((await client.pages('actions/runs', 'workflow_runs')).length, 101);
  assert.equal(calls.length, 2);
  client.command = async () => ({ stdout: JSON.stringify({ total_count: 99, workflow_runs: [] }) });
  await assert.rejects(client.pages('actions/runs', 'workflow_runs'), {
    code: 'truncated_inventory',
  });
});
