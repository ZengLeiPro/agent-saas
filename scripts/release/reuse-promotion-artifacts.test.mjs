import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { hydrateArtifacts, reusableArtifactPlan } from './reuse-promotion-artifacts.mjs';

test('真实工作流的 SSH 探测不会吞掉第二个制品的循环输入', async () => {
  const { spawnSync } = await import('node:child_process');
  const { chmod } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'reuse-probe-'));
  const bin = join(root, 'bin');
  await mkdir(bin);
  // 模拟 SSH 默认转发 stdin；-n 才会断开循环输入。
  await writeFile(join(bin, 'ssh'), '#!/bin/bash\nif [ "$1" != -n ]; then cat >/dev/null; fi\n');
  await chmod(join(bin, 'ssh'), 0o755);
  await writeFile(
    join(root, 'reusable-artifact-plan.tsv'),
    'server-bundle.tgz\tdigest1\t/source/server\nacs-orchestrator.tgz\tdigest2\t/source/acs\n',
  );
  const list = join(root, 'reusable.txt');
  await writeFile(list, '');
  const workflow = await readFile(
    new URL('../../.github/workflows/promote-release.yml', import.meta.url),
    'utf8',
  );
  const start = workflow.indexOf("            while IFS=$'\\t'");
  const marker = 'done < "$RUNNER_TEMP/reusable-artifact-plan.tsv"';
  const end = workflow.indexOf(marker, start) + marker.length;
  assert.ok(start > 0 && end > start);
  const result = spawnSync('bash', ['-c', 'set -euo pipefail\n' + workflow.slice(start, end)], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: bin + ':' + process.env.PATH,
      RUNNER_TEMP: root,
      reusable_list: list,
      ECS_USER: 'test',
      ECS_HOST: 'test',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual((await readFile(list, 'utf8')).trim().split('\n'), [
    'server-bundle.tgz',
    'acs-orchestrator.tgz',
  ]);
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'reuse-promotion-'));
  await mkdir(join(root, 'artifacts'));
  const source = join(root, 'cached.tgz');
  const bytes = Buffer.from('immutable release archive');
  await writeFile(source, bytes);
  const digest = createHash('sha256').update(bytes).digest('hex');
  return { root, source, bytes, plan: [{ filename: 'server-bundle.tgz', source, digest }] };
}

test('只从 Manifest 摘要推导固定发布目录，非法标识不能进入 Shell', () => {
  const digest = 'a'.repeat(64);
  const plan = reusableArtifactPlan({
    components: {
      api: { action: 'deploy', artifactDigest: 'sha256:' + digest },
      acs: { action: 'keep' },
    },
  });
  assert.equal(
    plan[0].source,
    '/opt/agent-saas-app/releases/' + digest + '/.release/server-bundle.tgz',
  );
  assert.throws(
    () =>
      reusableArtifactPlan({
        components: {
          api: { action: 'deploy', artifactDigest: '../../other' },
          acs: { action: 'keep' },
        },
      }),
    /Invalid reusable artifact/,
  );
});

test('复制前后校验摘要，保留原制品，已上传的匹配制品无需再复制', async () => {
  const f = await fixture();
  assert.equal(await hydrateArtifacts(f.plan, f.root), 1);
  assert.deepEqual(await readFile(join(f.root, 'artifacts/server-bundle.tgz')), f.bytes);
  assert.deepEqual(await readFile(f.source), f.bytes);
  assert.equal(await hydrateArtifacts(f.plan, f.root), 0);
});

test('探测后缓存变化时拒绝复用，不能把旧探测当作写入证据', async () => {
  const f = await fixture();
  await writeFile(f.source, 'changed after probe');
  await assert.rejects(hydrateArtifacts(f.plan, f.root), /digest mismatch/);
  await assert.rejects(readFile(join(f.root, 'artifacts/server-bundle.tgz')), /ENOENT/);
});

test('已有目标摘要错误时失败，不覆盖已存在的文件', async () => {
  const f = await fixture();
  const destination = join(f.root, 'artifacts/server-bundle.tgz');
  await writeFile(destination, 'corrupt');
  await assert.rejects(hydrateArtifacts(f.plan, f.root), /digest mismatch/);
  assert.equal(await readFile(destination, 'utf8'), 'corrupt');
});

test('缓存链接及缺失缓存均不能成为可复用制品', async () => {
  const f = await fixture();
  const link = join(f.root, 'link.tgz');
  await symlink(f.source, link);
  await assert.rejects(hydrateArtifacts([{ ...f.plan[0], source: link }], f.root), /regular file/);
  await assert.rejects(
    hydrateArtifacts([{ ...f.plan[0], source: join(f.root, 'absent') }], f.root),
    /ENOENT/,
  );
});
