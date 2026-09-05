/** §9.3-14 密钥扫描器：三条规则各自的正反用例。 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { formatFindings, scanSecrets } from './secretScan.js';

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ky-app-scan-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(relative: string, content: string): Promise<void> {
  const full = join(dir, relative);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content, 'utf8');
}

describe('scanSecrets', () => {
  it('干净的项目没有任何命中', async () => {
    await write('.env.example', 'KY_ENV=\nDATABASE_URL=\nPORT=\n');
    await write('server/index.ts', 'export const port = Number(process.env.PORT);\n');
    await write('README.md', '请求头 Authorization: Bearer <token>\n');
    expect(await scanSecrets(dir)).toEqual([]);
  });

  it('.env 里的真值被拦下，.env.example 不被拦', async () => {
    await write('.env', 'KY_INSTALLATION_KEY=0123456789abcdef\n# 注释\nEMPTY=\n');
    await write('.env.example', 'KY_INSTALLATION_KEY=\n');
    const findings = await scanSecrets(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: 'env_value', file: '.env', line: 1 });
    expect(formatFindings(findings)).toContain('[env_value]');
  });

  it('.env 里的 ${...} 占位与 <占位> 不算真值', async () => {
    await write('.env', 'A=${FROM_VAULT}\nB=<在密钥管理里配置>\n');
    expect(await scanSecrets(dir)).toEqual([]);
  });

  it('私钥 PEM 被拦下（含 Markdown）', async () => {
    await write('keys/dev.pem', '-----BEGIN EC PRIVATE KEY-----\nAAAA\n');
    await write('docs/note.md', '-----BEGIN PRIVATE KEY-----\n');
    const rules = (await scanSecrets(dir)).map((finding) => finding.rule);
    expect(rules).toEqual(['private_key', 'private_key']);
  });

  it('源码里的 `Bearer ` 字面量被拦下，Markdown 豁免', async () => {
    await write('web/api.ts', 'const h = { authorization: "Bearer " + token };\n');
    await write('docs/protocol.md', 'Authorization: Bearer abc\n');
    const findings = await scanSecrets(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: 'bearer_literal', file: 'web/api.ts' });
  });

  it('测试夹具白名单可以豁免 Bearer 规则', async () => {
    await write('src/__tests__/fixture.ts', 'export const h = "Bearer abc";\n');
    expect(await scanSecrets(dir)).toHaveLength(1);
    expect(await scanSecrets(dir, { allowBearerIn: ['__tests__/'] })).toEqual([]);
  });

  it('不进入 node_modules / dist', async () => {
    await write('node_modules/pkg/index.js', 'const h = "Bearer abc";\n');
    await write('dist/bundle.js', 'const h = "Bearer abc";\n');
    expect(await scanSecrets(dir)).toEqual([]);
  });
});
