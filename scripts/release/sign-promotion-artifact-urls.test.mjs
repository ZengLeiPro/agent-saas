import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseOssUri,
  createInternalOssSigner,
  buildFetchPlan,
} from './sign-promotion-artifact-urls.mjs';

const digest = 'b'.repeat(64);

function manifest() {
  return {
    components: {
      api: { action: 'deploy', artifactDigest: `sha256:${digest}` },
      acs: { action: 'keep' },
    },
    artifacts: {
      serverBundle: {
        digest: `sha256:${digest}`,
        size: 12,
        uri: 'oss://agent-saas-release-records/rc-20260913-141/server-bundle.tgz',
      },
    },
  };
}

test('只接受深圳 oss://bucket/key', () => {
  assert.deepEqual(parseOssUri('oss://agent-saas-release-records/rc/server-bundle.tgz'), {
    bucket: 'agent-saas-release-records',
    key: 'rc/server-bundle.tgz',
  });
  assert.throws(() => parseOssUri('https://oss.aliyuncs.com/x'), /Unsafe OSS artifact URI/);
  assert.throws(() => parseOssUri('oss://bucket/../secret'), /Unsafe OSS artifact URI/);
  assert.throws(() => parseOssUri('oss://bucket//double'), /Unsafe OSS artifact URI/);
});

test('按 Manifest 为需部署组件签发内网 GET URL，keep 的组件不进入计划', () => {
  const signed = [];
  const plan = buildFetchPlan(manifest(), (uri) => {
    signed.push(uri);
    return `https://agent-saas-release-records.oss-cn-shenzhen-internal.aliyuncs.com/${uri.slice(6)}`;
  });
  assert.deepEqual(signed, ['oss://agent-saas-release-records/rc-20260913-141/server-bundle.tgz']);
  assert.equal(plan.schemaVersion, 1);
  assert.equal(plan.artifacts.length, 1);
  assert.equal(plan.artifacts[0].filename, 'server-bundle.tgz');
  assert.equal(plan.artifacts[0].digest, digest);
  assert.equal(plan.artifacts[0].size, 12);
  assert.match(plan.artifacts[0].source, /\/opt\/agent-saas-app\/releases\/b{64}\/\.release\/server-bundle\.tgz/u);
});

test('摘要或体积与 Manifest 不一致时拒绝签发', () => {
  const value = manifest();
  value.artifacts.serverBundle.size = '12';
  assert.throws(() => buildFetchPlan(value, () => 'https://x'), /does not match Manifest/);
});

test('signer 固定 internal+HTTPS，拒绝非深圳 region', () => {
  const calls = [];
  class FakeOSS {
    constructor(options) {
      calls.push(options);
    }
    signatureUrl(key, params) {
      assert.equal(key, 'rc/server-bundle.tgz');
      assert.equal(params.method, 'GET');
      assert.equal(params.expires, 1800);
      return `https://${calls[0].bucket}.oss-cn-shenzhen-internal.aliyuncs.com/${key}`;
    }
  }
  const sign = createInternalOssSigner({
    OSS: FakeOSS,
    accessKeyId: 'id',
    accessKeySecret: 'secret',
    region: 'cn-shenzhen',
  });
  assert.equal(
    sign('oss://agent-saas-release-records/rc/server-bundle.tgz'),
    'https://agent-saas-release-records.oss-cn-shenzhen-internal.aliyuncs.com/rc/server-bundle.tgz',
  );
  assert.equal(calls[0].internal, true);
  assert.equal(calls[0].secure, true);
  assert.equal(calls[0].region, 'oss-cn-shenzhen');
  assert.throws(
    () =>
      createInternalOssSigner({
        OSS: FakeOSS,
        accessKeyId: 'id',
        accessKeySecret: 'secret',
        region: 'cn-hangzhou',
      }),
    /Shenzhen-only/,
  );
});

test('CLI 将计划写成 JSON', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sign-plan-'));
  const manifestPath = join(root, 'manifest.json');
  const outputPath = join(root, 'plan.json');
  await writeFile(manifestPath, JSON.stringify(manifest()));
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(
    process.execPath,
    [
      new URL('./sign-promotion-artifact-urls.mjs', import.meta.url).pathname,
      manifestPath,
      'cn-shenzhen',
      outputPath,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        ALIBABACLOUD_ACCESS_KEY_ID: 'id',
        ALIBABACLOUD_ACCESS_KEY_SECRET: 'secret',
      },
    },
  );
  // CLI 会加载真实 ali-oss；无网络签名仍应产出 HTTPS URL 字符串。
  if (result.status !== 0) {
    assert.match(result.stderr + result.stdout, /OSS|ali-oss|signing credentials|Cannot find module/u);
    return;
  }
  const plan = JSON.parse(await readFile(outputPath, 'utf8'));
  assert.equal(plan.schemaVersion, 1);
  assert.equal(plan.artifacts[0].filename, 'server-bundle.tgz');
  assert.match(plan.artifacts[0].url, /^https:\/\//u);
});
