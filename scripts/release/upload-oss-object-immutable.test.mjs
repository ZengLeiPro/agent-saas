import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL('./upload-oss-object-immutable.sh', import.meta.url));

async function fixture({
  stat = 'exists',
  listed = false,
  remote = 'release-bytes',
  mismatch = false,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'immutable-oss-upload-'));
  const sourcePath = join(root, 'source.tgz');
  const remotePath = join(root, 'remote-object');
  const logPath = join(root, 'aliyun.log');
  const aliyunPath = join(root, 'aliyun');
  await writeFile(sourcePath, 'release-bytes');
  await writeFile(remotePath, remote);
  await writeFile(
    aliyunPath,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_LOG"
test "$1" = --secure
test "$2" = oss
case "$3" in
  stat)
    case "$FAKE_STAT" in
      exists) exit 0 ;;
      missing) echo 'ErrorCode: NoSuchKey, StatusCode: 404' >&2; exit 2 ;;
      denied) echo 'ErrorCode: AccessDenied, StatusCode: 403' >&2; exit 3 ;;
      error) echo 'StatusCode: 503 ServiceUnavailable' >&2; exit 7 ;;
    esac
    ;;
  ls)
    if [[ "$FAKE_LISTED" = 1 ]]; then
      printf '2026-08-29 00:00:00 +0800 CST 1 Standard ETAG %s\n' "$4"
      printf 'Object Number is: 1\n'
    else
      printf 'Object Number is: 0\n'
    fi
    ;;
  cp)
    if [[ "$4" == oss://* ]]; then
      if [[ "$FAKE_READBACK_MISMATCH" = 1 ]]; then
        printf 'tampered-bytes' > "$5"
      else
        cp "$FAKE_REMOTE" "$5"
      fi
    else
      cp "$4" "$FAKE_REMOTE"
    fi
    ;;
esac
`,
  );
  await chmod(aliyunPath, 0o755);

  return {
    root,
    sourcePath,
    remotePath,
    logPath,
    async run() {
      return execFileAsync('bash', [scriptPath, sourcePath, 'oss://bucket/releases/object.tgz'], {
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH}`,
          FAKE_LOG: logPath,
          FAKE_REMOTE: remotePath,
          FAKE_STAT: stat,
          FAKE_LISTED: listed ? '1' : '0',
          FAKE_READBACK_MISMATCH: mismatch ? '1' : '0',
          RELEASE_RECORD_OSS_REGION: 'cn-shenzhen',
        },
      });
    },
    async log() {
      return (await readFile(logPath, 'utf8')).trim().split('\n');
    },
  };
}

test('reads back an existing object without uploading it again', async () => {
  const state = await fixture();
  try {
    await state.run();
    const log = await state.log();
    assert.equal(log.length, 2);
    assert.equal(log[0], '--secure oss stat oss://bucket/releases/object.tgz --region cn-shenzhen');
    assert.match(
      log[1],
      /^--secure oss cp oss:\/\/bucket\/releases\/object\.tgz .* --region cn-shenzhen$/u,
    );
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test('uploads only after a recognizable 404 and reads the same bytes back', async () => {
  const state = await fixture({ stat: 'missing', remote: 'old-bytes' });
  try {
    await state.run();
    assert.equal(await readFile(state.remotePath, 'utf8'), 'release-bytes');
    const log = await state.log();
    assert.equal(log.length, 3);
    assert.match(
      log[1],
      /^--secure oss cp .*source\.tgz oss:\/\/bucket\/releases\/object\.tgz --region cn-shenzhen$/u,
    );
    assert.match(
      log[2],
      /^--secure oss cp oss:\/\/bucket\/releases\/object\.tgz .* --region cn-shenzhen$/u,
    );
    assert.ok(log.every((line) => !/--force|--forbid-overwrite/u.test(line)));
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test('uses an exact listing to recognize OSS RAM 403 as a missing object', async () => {
  const state = await fixture({ stat: 'denied', remote: 'old-bytes' });
  try {
    await state.run();
    assert.equal(await readFile(state.remotePath, 'utf8'), 'release-bytes');
    const log = await state.log();
    assert.equal(log.length, 4);
    assert.equal(
      log[1],
      '--secure oss ls oss://bucket/releases/object.tgz --limited-num 2 --region cn-shenzhen',
    );
    assert.match(
      log[2],
      /^--secure oss cp .*source\.tgz oss:\/\/bucket\/releases\/object\.tgz --region cn-shenzhen$/u,
    );
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test('does not overwrite an exact object that is visible only through listing', async () => {
  const state = await fixture({ stat: 'denied', listed: true });
  try {
    await state.run();
    const log = await state.log();
    assert.equal(log.length, 3);
    assert.equal(log[0], '--secure oss stat oss://bucket/releases/object.tgz --region cn-shenzhen');
    assert.equal(
      log[1],
      '--secure oss ls oss://bucket/releases/object.tgz --limited-num 2 --region cn-shenzhen',
    );
    assert.match(
      log[2],
      /^--secure oss cp oss:\/\/bucket\/releases\/object\.tgz .* --region cn-shenzhen$/u,
    );
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test('fails closed on non-404 stat errors without attempting an upload', async () => {
  const state = await fixture({ stat: 'error' });
  try {
    await assert.rejects(state.run(), (error) => {
      assert.equal(error.code, 7);
      assert.match(error.stderr, /503 ServiceUnavailable/u);
      return true;
    });
    assert.deepEqual(await state.log(), [
      '--secure oss stat oss://bucket/releases/object.tgz --region cn-shenzhen',
    ]);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test('rejects an uploaded object whose byte-for-byte readback differs', async () => {
  const state = await fixture({ stat: 'missing', mismatch: true });
  try {
    await assert.rejects(state.run());
    const log = await state.log();
    assert.equal(log.length, 3);
    assert.match(
      log[1],
      /^--secure oss cp .*source\.tgz oss:\/\/bucket\/releases\/object\.tgz --region cn-shenzhen$/u,
    );
    assert.match(
      log[2],
      /^--secure oss cp oss:\/\/bucket\/releases\/object\.tgz .* --region cn-shenzhen$/u,
    );
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});
