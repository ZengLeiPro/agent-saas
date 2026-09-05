import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const workflow = readFileSync(
  new URL('../../.github/workflows/promote-release.yml', import.meta.url),
  'utf8',
);
const backup = workflow.slice(
  workflow.indexOf('          # stat 还会读取对象 ACL'),
  workflow.indexOf('          restore_web_entry()'),
);

function run(mode) {
  const root = mkdtempSync(join(tmpdir(), 'promotion-web-backup-'));
  const result = spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
mkdir -p "$RUNNER_TEMP/web-before"
run_with_web_lock() {
  case "$4" in
    stat) echo 'AccessDenied: no read acl permission' >&2; return 1 ;;
    ls)
      if [ "$MODE" = list_error ]; then echo 'ListObjects AccessDenied' >&2; return 1; fi
      # 相同前缀的对象不能被当作当前对象存在。
      printf 'date size %s.backup\\n' "$5"
      if [ "$MODE" != missing ]; then printf 'date size %s\\n' "$5"; fi
      ;;
    cp)
      if [ "$MODE" = read_error ]; then echo 'GetObject AccessDenied' >&2; return 1; fi
      printf 'old entry' > "$6"
      ;;
    *) echo 'unexpected OSS command' >&2; return 1 ;;
  esac
}
${backup}
printf 'identity=%s\\n' "$had_identity"
`,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        MODE: mode,
        RUNNER_TEMP: root,
        PRODUCTION_WEB_OSS_URI: 'oss://agent-saas-web',
        RELEASE_RECORD_OSS_REGION: 'cn-shenzhen',
      },
    },
  );
  return { result, root };
}

test('真实 Web 备份步骤不需要对象 ACL 权限', () => {
  const { result, root } = run('present');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /identity=true/u);
  assert.equal(readFileSync(join(root, 'web-before/index.html'), 'utf8'), 'old entry');
  assert.equal(readFileSync(join(root, 'web-before/release-identity.json'), 'utf8'), 'old entry');
});

test('可选身份对象缺失时不误认同前缀对象', () => {
  const { result, root } = run('missing');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /identity=false/u);
  assert.equal(existsSync(join(root, 'web-before/release-identity.json')), false);
});

for (const mode of ['list_error', 'read_error']) {
  test(`Web 备份 ${mode} 必须阻断并保留真实错误`, () => {
    const { result } = run(mode);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /AccessDenied/u);
    assert.doesNotMatch(result.stdout, /identity=/u);
  });
}
