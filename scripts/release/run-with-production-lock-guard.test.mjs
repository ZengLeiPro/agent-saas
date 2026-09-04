import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const helper = new URL('./run-with-production-lock-guard.sh', import.meta.url);

test('terminates the guarded process group when Production lock owner proof is lost', async () => {
  const root = await mkdtemp(join(tmpdir(), 'production-lock-guard-'));
  const bin = join(root, 'bin');
  const counter = join(root, 'counter');
  const terminated = join(root, 'terminated');
  await mkdir(bin);
  await writeFile(
    join(bin, 'ssh'),
    `#!/usr/bin/env bash\nset -eu\ncount=0\n[ ! -f '${counter}' ] || count=$(cat '${counter}')\ncount=$((count + 1))\nprintf '%s' "$count" > '${counter}'\n[ "$count" -eq 1 ]\n`,
  );
  await writeFile(
    join(bin, 'mutation'),
    `#!/usr/bin/env bash\ntrap 'printf terminated > "${terminated}"; exit 0' TERM INT\nwhile true; do sleep 0.1; done\n`,
  );
  await Promise.all([chmod(join(bin, 'ssh'), 0o755), chmod(join(bin, 'mutation'), 0o755)]);

  const result = spawnSync('bash', [helper.pathname, 'mutation'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      ECS_USER: 'deploy',
      ECS_HOST: 'production.example',
      PRODUCTION_LOCK_SCRIPT: '/run/lock.sh',
      PRODUCTION_LOCK_TOKEN: 'run-attempt-web',
      PRODUCTION_LOCK_SSH_KEY: '/tmp/key',
    },
  });

  assert.equal(result.status, 70, result.stderr);
  assert.match(result.stderr, /owner proof was lost/u);
  assert.equal(await readFile(terminated, 'utf8'), 'terminated');
  await rm(root, { recursive: true, force: true });
});
