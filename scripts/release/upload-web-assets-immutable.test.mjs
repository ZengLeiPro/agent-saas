import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const runUploader = (root, env = {}) =>
  spawnSync(
    'bash',
    [
      'scripts/release/upload-web-assets-immutable.sh',
      join(root, 'assets'),
      'oss://web-bucket/assets',
    ],
    {
      cwd: process.cwd(),
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
  await writeFile(join(root, 'assets', 'app-abc.js'), 'console.log("stable");\n');
  await writeFile(join(root, 'assets', 'style-def.css'), 'body { color: black; }\n');
  await writeFile(join(root, 'assets', 'logo-ghi.svg'), '<svg/>\n');
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
    source="$1"; target="$2"; shift 2
    if [[ "$source" = oss://* ]]; then
      source="$(uri_to_path "$source")"
      mkdir -p "$(dirname "$target")"
      cp "$source" "$target"
    else
      target_uri="$target"
      target="$(uri_to_path "$target_uri")"
      forbid=false
      cache=''
      content_type=''
      content_encoding=''
      while [ "$#" -gt 0 ]; do
        case "$1" in
          --meta)
            [ "\${2:-}" = x-oss-forbid-overwrite:true ] && forbid=true
            shift 2
            ;;
          --cache-control) cache="\${2:-}"; shift 2 ;;
          --content-type) content_type="\${2:-}"; shift 2 ;;
          --content-encoding) content_encoding="\${2:-}"; shift 2 ;;
          *) shift ;;
        esac
      done
      mkdir -p "$(dirname "$target")"
      relative="\${target_uri#oss://web-bucket/}"
      if [ "\${FAKE_RACE_KEY:-}" = "$relative" ] && [ ! -e "$target" ]; then
        printf 'concurrent-object' > "$target"
        echo '409 FileAlreadyExists' >&2
        exit 90
      fi
      if [ -e "$target" ] && [ "$forbid" = true ]; then
        echo '409 FileAlreadyExists' >&2
        exit 90
      fi
      cp "$source" "$target"
      {
        printf 'HTTP/1.1 200 OK\r\nCache-Control: %s\r\nContent-Type: %s\r\n' \
          "$cache" "$content_type"
        if [ -n "$content_encoding" ]; then printf 'Content-Encoding: %s\r\n' "$content_encoding"; fi
        printf '\r\n'
      } > "$target.headers"
    fi
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
  await writeFile(join(root, 'bin', 'ossutil'), ossutil);
  await writeFile(join(root, 'bin', 'curl'), curl);
  await chmod(join(root, 'bin', 'ossutil'), 0o755);
  await chmod(join(root, 'bin', 'curl'), 0o755);
  return root;
};

test('atomically uploads final Web asset bytes and reuses only byte-identical keys', async () => {
  const root = await setupFixture();
  const first = runUploader(root);
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
  const firstUploads = firstLog.split('\n').filter((line) => /^cp \/.* oss:\/\//u.test(line));
  assert.equal(firstUploads.length, 3);
  assert.ok(firstUploads.every((line) => line.includes('--meta x-oss-forbid-overwrite:true')));
  assert.ok(firstUploads.every((line) => !/(?:^| )-f(?: |$)/u.test(line)));

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

test('rejects immutable assets whose uploaded cache or content headers drift', async () => {
  const root = await setupFixture();
  const result = runUploader(root, { FAKE_BAD_HEADERS: 'true' });
  assert.notEqual(result.status, 0);
});
