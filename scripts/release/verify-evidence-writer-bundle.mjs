#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildEvidenceWriter } from './build-evidence-writer.mjs';
import {
  createValidReleaseEvidence,
  RELEASE_EVIDENCE_SHA,
} from './release-evidence-fixture.test-helper.mjs';

export async function verifyEvidenceWriterBundle(build) {
  const temporary = await mkdtemp(join(tmpdir(), 'writer-bundle-smoke-'));
  const readToken = 'local-writer-read-token-000000000000000000000000';
  const writeToken = 'local-writer-write-token-000000000000000000000000';
  try {
    const release = join(temporary, 'release');
    const current = join(temporary, 'current');
    await mkdir(release);
    execFileSync('tar', ['-xzf', build.archivePath, '-C', release]);
    await symlink(release, current);
    await writeFile(join(temporary, 'read.token'), readToken, { mode: 0o600 });
    await writeFile(join(temporary, 'write.token'), writeToken, { mode: 0o600 });
    // Match both the old absolute symlink smoke and the actual systemd cwd + relative entry.
    for (const entry of [
      join(current, 'scripts/release/evidence-service.mjs'),
      'scripts/release/evidence-service.mjs',
    ]) {
      const probe = createServer();
      await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
      const port = probe.address().port;
      await new Promise((resolve) => probe.close(resolve));
      let output = '';
      const child = spawn(process.execPath, [entry], {
        cwd: current,
        env: {
          ...process.env,
          RELEASE_EVIDENCE_ROOT: join(temporary, 'data'),
          RELEASE_EVIDENCE_READ_TOKEN_FILE: join(temporary, 'read.token'),
          RELEASE_EVIDENCE_WRITE_TOKEN_FILE: join(temporary, 'write.token'),
          RELEASE_EVIDENCE_HOST: '127.0.0.1',
          RELEASE_EVIDENCE_PORT: String(port),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (chunk) => {
        output += chunk;
      });
      child.stderr.on('data', (chunk) => {
        output += chunk;
      });
      const closed = new Promise((resolve) => child.once('close', resolve));
      try {
        for (let attempt = 0; !output.includes('release evidence service listening'); attempt++) {
          if (child.exitCode !== null || attempt >= 100)
            throw new Error(`Bundled Writer did not start: ${output}`);
          await delay(50);
        }
        const api = `http://127.0.0.1:${port}`;
        const readHeaders = { authorization: `Bearer ${readToken}` };
        const writeHeaders = {
          authorization: `Bearer ${writeToken}`,
          'content-type': 'application/json',
        };
        const request = (path, options = {}) =>
          fetch(`${api}${path}`, { ...options, signal: AbortSignal.timeout(5000) });
        assert.equal((await request('/capabilities')).status, 401);
        const capability = await request('/capabilities', { headers: readHeaders });
        assert.equal(capability.status, 200);
        const identity = await capability.json();
        assert.equal(identity.implementationDigest, build.implementationDigest);
        assert.equal(
          identity.currentReleaseEvidenceSchemaVersion,
          build.releaseEvidenceSchemaVersion,
        );
        assert.equal(identity.releaseEvidenceSchemaRevision, build.releaseEvidenceSchemaRevision);
        const path = `/release-evidence?sha=${RELEASE_EVIDENCE_SHA}`;
        const evidence = createValidReleaseEvidence();
        assert.equal(
          (
            await request(path, {
              method: 'POST',
              headers: readHeaders,
              body: JSON.stringify(evidence),
            })
          ).status,
          401,
        );
        assert.equal(
          (
            await request(path, {
              method: 'POST',
              headers: writeHeaders,
              body: JSON.stringify(evidence),
            })
          ).status,
          201,
        );
        const result = await request(path, { headers: readHeaders });
        assert.equal(result.status, 200);
        assert.deepEqual(await result.json(), evidence);
        const conflict = createValidReleaseEvidence({ sourcePullRequests: [202] });
        assert.notEqual(
          (
            await request(path, {
              method: 'POST',
              headers: writeHeaders,
              body: JSON.stringify(conflict),
            })
          ).status,
          201,
        );
      } finally {
        child.kill('SIGTERM');
        const killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
        await closed;
        clearTimeout(killTimer);
      }
    }
    return {
      status: 'passed',
      implementationDigest: build.implementationDigest,
      checks: [
        'archive-extraction',
        'symlink-entry',
        'systemd-relative-entry',
        'capabilities',
        'separate-tokens',
        'immutable-write-readback',
      ],
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const temporary = await mkdtemp(join(tmpdir(), 'writer-build-smoke-'));
  try {
    const build = process.argv[2]
      ? JSON.parse(await readFile(process.argv[2], 'utf8'))
      : await buildEvidenceWriter(temporary);
    process.stdout.write(`${JSON.stringify(await verifyEvidenceWriterBundle(build))}\n`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
