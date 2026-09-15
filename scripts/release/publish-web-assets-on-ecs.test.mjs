import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';

const repositoryRoot = process.cwd();
const script = join(repositoryRoot, 'scripts/release/publish-web-assets-on-ecs.sh');

test('ECS publisher verifies digest, extracts assets, and invokes uploader with internal flag', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ecs-web-publish-'));
  const web = join(root, 'web');
  await mkdir(join(web, 'assets'), { recursive: true });
  await writeFile(join(web, 'assets', 'app.js'), 'console.log(1);\n');
  await writeFile(join(web, 'assets', 'style.css'), 'body{}\n');
  await writeFile(join(web, 'index.html'), '<html></html>\n');
  const archive = join(root, 'web-assets.tgz');
  execFileSync('tar', ['-czf', archive, '-C', web, '.']);
  const digest = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex');
  await writeFile(
    join(root, 'credentials.json'),
    '{"accessKeyId":"id","accessKeySecret":"secret"}',
  );
  await mkdir(join(root, 'ali-oss'));
  await writeFile(join(root, 'ali-oss', 'package.json'), '{"name":"ali-oss","main":"index.js"}');
  await writeFile(join(root, 'ali-oss', 'index.js'), 'module.exports = class Fake {};');
  await mkdir(join(root, 'bin'));
  const calls = join(root, 'uploader-calls.log');
  // Shadow the real uploader via PATH? publish script calls script_dir uploader.
  // Instead wrap by replacing PATH to a fake bash that records argv when running the uploader name.
  // Simpler: monkeypatch by placing a stub next to a copied script tree.
  const release = join(root, 'release');
  await mkdir(release);
  for (const name of [
    'publish-web-assets-on-ecs.sh',
    'upload-web-assets-immutable.sh',
    'put-web-asset-create-only.mjs',
    'get-web-object.mjs',
    'repair-web-asset-metadata.mjs',
  ]) {
    await writeFile(
      join(release, name),
      await readFile(join(repositoryRoot, 'scripts/release', name)),
    );
  }
  await chmod(join(release, 'publish-web-assets-on-ecs.sh'), 0o755);
  await chmod(join(release, 'upload-web-assets-immutable.sh'), 0o755);
  await writeFile(
    join(release, 'upload-web-assets-immutable.sh'),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" > '${calls}'
test "\${OSS_INTERNAL:-}" = 1
test "\${9:-}" = internal -o "\$#" -ge 9
`,
  );
  await chmod(join(release, 'upload-web-assets-immutable.sh'), 0o755);

  const extract = join(root, 'extract');
  const result = spawnSync(
    'bash',
    [
      join(release, 'publish-web-assets-on-ecs.sh'),
      archive,
      digest,
      extract,
      'oss://agent-saas-web/assets',
      join(root, 'credentials.json'),
      join(root, 'ali-oss'),
      'https://agent.kaiyan.net',
      '8',
      '60',
      join(root, 'diag'),
    ],
    { encoding: 'utf8', env: { ...process.env, OSS_REGION: 'cn-shenzhen' } },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(await readFile(calls, 'utf8'), /oss:\/\/agent-saas-web\/assets/u);
  assert.match(await readFile(calls, 'utf8'), /internal/u);
  assert.equal(await readFile(join(extract, 'index.html'), 'utf8'), '<html></html>\n');

  const bad = spawnSync(
    'bash',
    [
      join(release, 'publish-web-assets-on-ecs.sh'),
      archive,
      '0'.repeat(64),
      join(root, 'extract-bad'),
      'oss://agent-saas-web/assets',
      join(root, 'credentials.json'),
      join(root, 'ali-oss'),
      'https://agent.kaiyan.net',
    ],
    { encoding: 'utf8', env: { ...process.env, OSS_REGION: 'cn-shenzhen' } },
  );
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /digest mismatch/u);
});
