import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const workflow = readFileSync(
  new URL('../../.github/workflows/promote-release.yml', import.meta.url),
  'utf8',
);
const uploadStep = workflow
  .split('- name: Upload immutable deploy payload')[1]
  .split('\n      - name:')[0];
const remoteCommand = uploadStep.slice(uploadStep.indexOf('          ssh -i')).trim();
const isRoot = process.getuid?.() === 0;
const canSudo = spawnSync('sudo', ['-n', 'true']).status === 0;
const supported = process.platform === 'linux' && (isRoot || canSudo);

function fixture({ existingLockDirectory = false, wrongDigest = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'promotion-payload-'));
  const source = join(root, 'source');
  const bin = join(root, 'bin');
  const locks = join(root, 'locks');
  const remote = join(root, 'deployed');
  mkdirSync(source);
  mkdirSync(join(source, 'artifacts'));
  writeFileSync(
    join(source, 'manifest.json'),
    JSON.stringify({ components: { api: { action: 'keep' }, acs: { action: 'keep' } } }),
  );
  writeFileSync(
    join(source, 'reuse-promotion-artifacts.mjs'),
    readFileSync(new URL('./reuse-promotion-artifacts.mjs', import.meta.url)),
  );
  mkdirSync(bin);
  writeFileSync(join(source, 'deploy-production-release.sh'), '#!/bin/bash\nexit 0\n');
  writeFileSync(join(bin, 'ssh'), '#!/bin/bash\nexec bash -c "${@: -1}"\n', { mode: 0o755 });
  // 容器内直接以 root 跑；GitHub Linux runner 使用真实 sudo。
  if (isRoot) writeFileSync(join(bin, 'sudo'), '#!/bin/bash\nexec "$@"\n', { mode: 0o755 });
  if (existingLockDirectory) {
    mkdirSync(locks);
    writeFileSync(join(locks, 'existing-lease'), 'preserve');
  }
  const archive = `${remote}.upload.tgz`;
  execFileSync('tar', ['-czf', archive, '-C', source, '.']);
  const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    PRODUCTION_ALREADY_TARGET: 'false',
    ECS_USER: 'root',
    ECS_HOST: 'isolated-test',
    remote,
    remote_archive: archive,
    root_archive: join(locks, 'payload.tgz'),
    archive_digest: wrongDigest ? '0'.repeat(64) : digest,
  };
  // 执行工作流原始 SSH 命令，仅将 /run 目录映射到隔离测试目录。
  const command = remoteCommand.replaceAll('/run/agent-saas-locks', locks);
  const result = spawnSync('bash', ['-c', command], { env, encoding: 'utf8' });
  return { root, locks, remote, env, result };
}

test('首次上传会创建 /run 目录，root 不会因只读文件仍可写而被误拒', { skip: !supported }, () => {
  const { locks, remote, env, result } = fixture();
  assert.equal(result.status, 0, result.stderr);
  const script = join(remote, 'deploy-production-release.sh');
  assert.equal(
    execFileSync('sudo', ['stat', '-c', '%u:%g:%a', locks], { env, encoding: 'utf8' }).trim(),
    '0:0:700',
  );
  assert.equal(
    execFileSync('sudo', ['stat', '-c', '%u:%g:%a', script], { env, encoding: 'utf8' }).trim(),
    '0:0:444',
  );
  assert.equal(spawnSync('sudo', ['test', '-w', script], { env }).status, 0);
});

test('已有锁目录中的其他租约保持，摘要错误仍阻断上传', { skip: !supported }, () => {
  const { locks, remote, env, result } = fixture({
    existingLockDirectory: true,
    wrongDigest: true,
  });
  assert.notEqual(result.status, 0);
  assert.equal(
    execFileSync('sudo', ['cat', join(locks, 'existing-lease')], { env, encoding: 'utf8' }),
    'preserve',
  );
  assert.notEqual(spawnSync('sudo', ['test', '-e', remote], { env }).status, 0);
});
