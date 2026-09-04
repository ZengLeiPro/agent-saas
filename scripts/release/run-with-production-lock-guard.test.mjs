import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

const helper = new URL('./run-with-production-lock-guard.sh', import.meta.url);

test('terminates an already active process group when Production lock owner proof is lost', async () => {
  const root = await mkdtemp(join(tmpdir(), 'production-lock-guard-'));
  const bin = join(root, 'bin');
  const counter = join(root, 'counter');
  const terminated = join(root, 'terminated');
  await mkdir(bin);
  await writeFile(
    join(bin, 'ssh'),
    `#!/usr/bin/env bash\nset -eu\ncount=0\n[ ! -f '${counter}' ] || count=$(cat '${counter}')\ncount=$((count + 1))\nprintf '%s' "$count" > '${counter}'\n[ "$count" -le 2 ]\n`,
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

test('terminates background members before a successful guarded command returns', async () => {
  const root = await mkdtemp(join(tmpdir(), 'production-lock-guard-background-'));
  const bin = join(root, 'bin');
  const childPidFile = join(root, 'child.pid');
  await mkdir(bin);
  await writeFile(join(bin, 'ssh'), '#!/usr/bin/env bash\nexit 0\n');
  await writeFile(
    join(bin, 'mutation'),
    `#!/usr/bin/env bash\n( trap '' TERM; while true; do sleep 1; done ) &\nprintf '%s' "$!" > '${childPidFile}'\n`,
  );
  await Promise.all([chmod(join(bin, 'ssh'), 0o755), chmod(join(bin, 'mutation'), 0o755)]);

  const result = spawnSync('bash', [helper.pathname, 'mutation'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: root,
      ECS_USER: 'deploy',
      ECS_HOST: 'production.example',
      PRODUCTION_LOCK_SCRIPT: '/run/lock.sh',
      PRODUCTION_LOCK_TOKEN: 'run-attempt-web',
      PRODUCTION_LOCK_SSH_KEY: '/tmp/key',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const childPid = Number(await readFile(childPidFile, 'utf8'));
  assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
  await rm(root, { recursive: true, force: true });
});

test('cancellation during the startup handshake cannot leave an unguarded mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'production-lock-guard-startup-'));
  const bin = join(root, 'bin');
  const setsidStarted = join(root, 'setsid-started');
  const mutationStarted = join(root, 'mutation-started');
  await mkdir(bin);
  await writeFile(join(bin, 'ssh'), '#!/usr/bin/env bash\nexit 0\n');
  await writeFile(
    join(bin, 'setsid'),
    `#!/usr/bin/env bash\nprintf started > '${setsidStarted}'\nsleep 0.5\nexec /usr/bin/setsid "$@"\n`,
  );
  await writeFile(
    join(bin, 'mutation'),
    `#!/usr/bin/env bash\nprintf started > '${mutationStarted}'\nwhile true; do sleep 1; done\n`,
  );
  await Promise.all([
    chmod(join(bin, 'ssh'), 0o755),
    chmod(join(bin, 'setsid'), 0o755),
    chmod(join(bin, 'mutation'), 0o755),
  ]);

  const child = spawn('bash', [helper.pathname, 'mutation'], {
    cwd: root,
    stdio: 'ignore',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: root,
      ECS_USER: 'deploy',
      ECS_HOST: 'production.example',
      PRODUCTION_LOCK_SCRIPT: '/run/lock.sh',
      PRODUCTION_LOCK_TOKEN: 'run-attempt-web',
      PRODUCTION_LOCK_SSH_KEY: '/tmp/key',
    },
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await readFile(setsidStarted);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  child.kill('SIGTERM');
  const [code] = await new Promise((resolve) => child.once('exit', (...args) => resolve(args)));
  assert.equal(code, 130);
  await assert.rejects(readFile(mutationStarted));
  await rm(root, { recursive: true, force: true });
});
