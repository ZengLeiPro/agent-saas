import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const repositoryRoot = process.cwd();
const runUploader = (root, env = {}, cwd = repositoryRoot) =>
  spawnSync(
    'bash',
    [
      join(repositoryRoot, 'scripts/release/upload-web-assets-immutable.sh'),
      join(root, 'assets'),
      'oss://web-bucket/assets',
      join(root, 'credentials.json'),
      join(root, 'fake-ali-oss.cjs'),
    ],
    {
      cwd,
      env: {
        ...process.env,
        PATH: `${join(root, 'bin')}:${process.env.PATH}`,
        OSS_REGION: 'cn-shenzhen',
        FAKE_OSS_ROOT: join(root, 'oss'),
        FAKE_OSS_LOG: join(root, 'oss.log'),
        ...env,
      },
      encoding: 'utf8',
    },
  );

const setupFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'immutable-web-assets-'));
  await mkdir(join(root, 'assets'), { recursive: true });
  await mkdir(join(root, 'bin'), { recursive: true });
  await mkdir(join(root, 'workflow-cwd'), { recursive: true });
  await writeFile(join(root, 'assets', 'app-abc.js'), 'console.log("stable");\n');
  await writeFile(join(root, 'assets', 'style-def.css'), 'body { color: black; }\n');
  await writeFile(join(root, 'assets', 'logo-ghi.svg'), '<svg/>\n');
  const aliOss = `const fs = require('node:fs');
const path = require('node:path');
module.exports = class FakeOSS {
  constructor(options) {
    if (options.region !== 'oss-cn-shenzhen') throw new Error('unexpected ali-oss region: ' + options.region);
  }
  async put(key, source, options) {
    fs.appendFileSync(process.env.FAKE_OSS_LOG, 'sdk-put ' + key + ' ' + JSON.stringify(options.headers) + '\\n');
    if (process.env.FAKE_PUT_ERROR) {
      const error = new Error(process.env.FAKE_PUT_ERROR);
      error.code = process.env.FAKE_PUT_ERROR;
      error.status = Number(process.env.FAKE_PUT_STATUS || 403);
      throw error;
    }
    const target = path.join(process.env.FAKE_OSS_ROOT, key);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (process.env.FAKE_RACE_KEY === key && !fs.existsSync(target)) {
      fs.writeFileSync(target, 'concurrent-object');
      const error = new Error('FileAlreadyExists');
      error.code = 'FileAlreadyExists';
      error.status = 409;
      throw error;
    }
    if (fs.existsSync(target)) {
      const error = new Error('FileAlreadyExists');
      error.code = 'FileAlreadyExists';
      error.status = 409;
      throw error;
    }
    fs.copyFileSync(source, target);
    const headers = options.headers;
    let text = 'HTTP/1.1 200 OK\\r\\nCache-Control: ' + headers['Cache-Control'] +
      '\\r\\nContent-Type: ' + headers['Content-Type'] + '\\r\\n';
    if (headers['Content-Encoding']) text += 'Content-Encoding: ' + headers['Content-Encoding'] + '\\r\\n';
    fs.writeFileSync(target + '.headers', text + '\\r\\n');
  }
};
`;
  const ossutil = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_OSS_LOG"
command="$1"; shift
uri_to_path() { printf '%s/%s' "$FAKE_OSS_ROOT" "\${1#oss://web-bucket/}"; }
case "$command" in
  stat)
    path="$(uri_to_path "$1")"
    if [ -f "$path" ]; then echo 'Content-Length: 1'; else echo 'StatusCode=404 ErrorCode=NoSuchKey' >&2; exit 1; fi
    ;;
  cp)
    source="$1"; target="$2"
    if [[ "$source" != oss://* ]]; then echo 'fake ossutil forbids uploads' >&2; exit 91; fi
    source="$(uri_to_path "$source")"
    mkdir -p "$(dirname "$target")"
    cp "$source" "$target"
    ;;
  *) exit 91 ;;
esac
`;
  const curl = `#!/usr/bin/env bash
set -euo pipefail
url="\${!#}"
relative="\${url#https://web-bucket.oss-cn-shenzhen.aliyuncs.com/}"
relative="\${relative%%\\?*}"
headers="$FAKE_OSS_ROOT/$relative.headers"
test -f "$headers"
if [ "\${FAKE_BAD_HEADERS:-false}" = true ]; then
  sed 's/public, max-age=31536000, immutable/public, max-age=60/' "$headers"
else
  cat "$headers"
fi
`;
  await writeFile(
    join(root, 'credentials.json'),
    JSON.stringify({ accessKeyId: 'test-id', accessKeySecret: 'test-secret' }),
  );
  await writeFile(join(root, 'fake-ali-oss.cjs'), aliOss);
  await writeFile(join(root, 'bin', 'ossutil'), ossutil);
  await writeFile(join(root, 'bin', 'curl'), curl);
  await chmod(join(root, 'bin', 'ossutil'), 0o755);
  await chmod(join(root, 'bin', 'curl'), 0o755);
  return root;
};

test('loads the repository-pinned ali-oss SDK put API', () => {
  const result = spawnSync(
    'node',
    ['scripts/release/put-web-asset-create-only.mjs', '--self-check'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /put API contract verified/u);
});

test('atomically uploads final Web asset bytes from the Workflow working directory', async () => {
  const root = await setupFixture();
  const first = runUploader(root, {}, join(root, 'workflow-cwd'));
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /uploaded=3 reused=0/u);
  const storedScript = await readFile(join(root, 'oss', 'assets', 'app-abc.js'));
  assert.equal(storedScript[0], 0x1f);
  assert.equal(storedScript[1], 0x8b);
  assert.match(
    await readFile(join(root, 'oss', 'assets', 'app-abc.js.headers'), 'utf8'),
    /Content-Type: text\/javascript; charset=utf-8[\s\S]*Content-Encoding: gzip/u,
  );

  const firstLog = await readFile(join(root, 'oss.log'), 'utf8');
  const sdkPuts = firstLog.split('\n').filter((line) => line.startsWith('sdk-put '));
  assert.equal(sdkPuts.length, 3);
  assert.ok(sdkPuts.every((line) => line.includes('"x-oss-forbid-overwrite":"true"')));
  assert.ok(!firstLog.split('\n').some((line) => /^cp \/.* oss:\/\//u.test(line)));

  const second = runUploader(root);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /uploaded=0 reused=3/u);
});

test('rejects same-key asset byte drift instead of overwriting the existing object', async () => {
  const root = await setupFixture();
  assert.equal(runUploader(root).status, 0);
  const before = await readFile(join(root, 'oss', 'assets', 'app-abc.js'));
  await writeFile(join(root, 'assets', 'app-abc.js'), 'console.log("changed");\n');
  const result = runUploader(root);
  assert.notEqual(result.status, 0);
  assert.deepEqual(await readFile(join(root, 'oss', 'assets', 'app-abc.js')), before);
});

test('rejects a concurrently created same-key object without overwriting it', async () => {
  const root = await setupFixture();
  const result = runUploader(root, { FAKE_RACE_KEY: 'assets/app-abc.js' });
  assert.notEqual(result.status, 0);
  assert.equal(
    await readFile(join(root, 'oss', 'assets', 'app-abc.js'), 'utf8'),
    'concurrent-object',
  );
});

test('does not treat non-conflict or non-409 SDK errors as reusable objects', async () => {
  for (const env of [
    { FAKE_PUT_ERROR: 'AccessDenied' },
    { FAKE_PUT_ERROR: 'FileAlreadyExists', FAKE_PUT_STATUS: '500' },
  ]) {
    const root = await setupFixture();
    const result = runUploader(root, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(env.FAKE_PUT_ERROR, 'u'));
    const log = await readFile(join(root, 'oss.log'), 'utf8');
    assert.doesNotMatch(log, /^stat /mu);
  }
});

test('rejects immutable assets whose uploaded cache or content headers drift', async () => {
  const root = await setupFixture();
  const result = runUploader(root, { FAKE_BAD_HEADERS: 'true' });
  assert.notEqual(result.status, 0);
});
