import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  hydrateArtifacts,
  reusableArtifactPlan,
  assertInternalOssUrl,
} from './reuse-promotion-artifacts.mjs';

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
  assert.deepEqual(await hydrateArtifacts(f.plan, f.root), {
    reusedArtifacts: 1,
    fetchedArtifacts: 0,
  });
  assert.deepEqual(await readFile(join(f.root, 'artifacts/server-bundle.tgz')), f.bytes);
  assert.deepEqual(await readFile(f.source), f.bytes);
  assert.deepEqual(await hydrateArtifacts(f.plan, f.root), {
    reusedArtifacts: 0,
    fetchedArtifacts: 0,
  });
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
    /ENOENT|Missing fetch URL/,
  );
});

test('本地缓存未命中时从预签名 URL 拉取并校验摘要', async () => {
  const f = await fixture();
  const fetched = Buffer.from('fetched from shenzhen oss');
  const digest = createHash('sha256').update(fetched).digest('hex');
  const url = 'https://agent-saas-release-records.oss-cn-shenzhen-internal.aliyuncs.com/rc/server-bundle.tgz';
  let downloaded = '';
  const result = await hydrateArtifacts(
    [
      {
        filename: 'server-bundle.tgz',
        digest,
        size: fetched.length,
        source: join(f.root, 'absent.tgz'),
        url,
      },
    ],
    f.root,
    {
      download: async (href, dest) => {
        downloaded = href;
        await writeFile(dest, fetched);
      },
    },
  );
  assert.equal(downloaded, url);
  assert.deepEqual(result, { reusedArtifacts: 0, fetchedArtifacts: 1 });
  assert.deepEqual(await readFile(join(f.root, 'artifacts/server-bundle.tgz')), fetched);
});

test('拒绝非深圳 OSS 内网预签名 URL', () => {
  assert.throws(
    () => assertInternalOssUrl('https://example.com/server-bundle.tgz'),
    /Shenzhen OSS internal/,
  );
  assert.throws(
    () =>
      assertInternalOssUrl(
        'https://agent-saas-release-records.oss-cn-shenzhen.aliyuncs.com/rc/server-bundle.tgz',
      ),
    /Shenzhen OSS internal/,
  );
  assert.throws(() => assertInternalOssUrl('http://bucket.oss-cn-shenzhen-internal.aliyuncs.com/x'), /HTTPS/);
  assertInternalOssUrl(
    'https://agent-saas-release-records.oss-cn-shenzhen-internal.aliyuncs.com/rc/server-bundle.tgz?Expires=1',
  );
});

test('工作流不再把 selected tgz 经 runner scp 回深圳', async () => {
  const workflow = await readFile(
    new URL('../../.github/workflows/promote-release.yml', import.meta.url),
    'utf8',
  );
  const upload = workflow
    .split('- name: 上传不可变部署载荷与 RC 绑定的托管单元')[1]
    .split('\n      - name:')[0];
  assert.equal(upload.includes('selected/"*.tgz'), false);
  assert.equal(upload.includes('while IFS='), false);
  assert.match(upload, /sign-promotion-artifact-urls\.mjs/u);
});

test('hydrate 允许 Staging 额外制品并从预签名 URL 拉取', async () => {
  const f = await fixture();
  const fetched = Buffer.from('staging runtime assets');
  const digest = createHash('sha256').update(fetched).digest('hex');
  const url =
    'https://agent-saas-staging-releases.oss-cn-shenzhen-internal.aliyuncs.com/rc/staging-runtime-assets.tgz';
  const result = await hydrateArtifacts(
    [
      {
        filename: 'staging-runtime-assets.tgz',
        digest,
        size: fetched.length,
        url,
      },
    ],
    f.root,
    {
      download: async (href, dest) => {
        assert.equal(href, url);
        await writeFile(dest, fetched);
      },
    },
  );
  assert.deepEqual(result, { reusedArtifacts: 0, fetchedArtifacts: 1 });
  assert.deepEqual(await readFile(join(f.root, 'artifacts/staging-runtime-assets.tgz')), fetched);
});

test('测试环境工作流不再把 selected tgz 经 runner scp 回深圳', async () => {
  const workflow = await readFile(
    new URL('../../.github/workflows/deploy-staging.yml', import.meta.url),
    'utf8',
  );
  const upload = workflow
    .split('- name: 部署精确的测试环境 API、Worker 与 ACS 产物\n')[1]
    .split('\n      - name:')[0];
  assert.equal(upload.includes('selected/"*.tgz'), false);
  assert.match(upload, /sign-promotion-artifact-urls\.mjs/u);
  assert.match(upload, /reuse-promotion-artifacts\.mjs/u);
});
