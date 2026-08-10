import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

// wrapper 用 os.memfd_create 把 AK profile 只留在匿名内存里、从不落盘——这是
// Linux-only 的系统调用，macOS 上 Python 的 os 模块没有该属性，本地跑必然
// AttributeError 退出码 1。生产（ACS pod / ECS）与 CI runner 都是 Linux，
// 故非 Linux 平台整体跳过，而不是让每个 macOS 开发者全量测试都挂一个红点。
describe.skipIf(process.platform !== 'linux')('aliyun runtime wrapper', () => {
  it('materializes a mode-0600 AK profile with the injected region and removes it after use', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'aliyun-wrapper-'));
    roots.push(root);
    const fakeCli = resolve(root, 'aliyun-real');
    writeFileSync(fakeCli, `#!/bin/sh
set -eu
config=''
previous=''
for arg in "$@"; do
  if [ "$previous" = '--config-path' ]; then config="$arg"; fi
  previous="$arg"
done
node - "$config" <<'NODE'
const fs = require('node:fs');
const path = process.argv[2];
const profile = JSON.parse(fs.readFileSync(path, 'utf8')).profiles[0];
console.log(JSON.stringify({ path, mode: profile.mode, regionId: profile.region_id, hasCredentials: Boolean(profile.access_key_id && profile.access_key_secret), hasSecurityToken: Boolean(profile.sts_token), fileMode: fs.statSync(path).mode & 0o777 }));
NODE
`);
    chmodSync(fakeCli, 0o755);

    const wrapper = resolve(process.cwd(), '../scripts/aliyun-runtime-wrapper.py');
    const result = spawnSync(wrapper, ['ecs', 'DescribeInstances', '--dryrun'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        TMPDIR: root,
        ALIYUN_REAL_BIN: fakeCli,
        ALIBABA_CLOUD_ACCESS_KEY_ID: 'LTAI.test',
        ALIBABA_CLOUD_ACCESS_KEY_SECRET: 'test-secret',
        ALIBABA_CLOUD_SECURITY_TOKEN: '',
        ALIBABA_CLOUD_REGION_ID: 'cn-shenzhen',
        ALIBABA_CLOUD_IGNORE_PROFILE: 'TRUE',
      },
    });

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout.trim()) as {
      path: string;
      mode: string;
      regionId: string;
      hasCredentials: boolean;
      hasSecurityToken: boolean;
      fileMode: number;
    };
    expect(output).toMatchObject({
      mode: 'AK',
      regionId: 'cn-shenzhen',
      hasCredentials: true,
      hasSecurityToken: false,
      fileMode: 0o600,
    });
    expect(output.path).toMatch(/^\/proc\/self\/fd\/\d+$/);
    expect(readdirSync(root).sort()).toEqual(['aliyun-real']);
    expect(readFileSync(wrapper, 'utf8')).not.toContain('LTAI.test');
  });
});
