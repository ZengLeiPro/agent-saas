import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const action = readFileSync(new URL('.github/actions/setup-pnpm/action.yml', root), 'utf8');
const pins = readFileSync(new URL('.github/pnpm-standalone.sha256', root), 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));

test('packageManager 固定的 pnpm 版本在 GitHub Release 二进制校验和清单里有记录', () => {
  const match = /^pnpm@(\d+\.\d+\.\d+)/u.exec(packageJson.packageManager ?? '');
  assert.ok(match, 'package.json packageManager must pin pnpm@<major.minor.patch>');
  const version = match[1];
  const entries = pins
    .split(/\r?\n/u)
    .filter((line) => line.trim() && !line.startsWith('#'))
    .map((line) => line.trim().split(/\s+/u));
  for (const entry of entries) {
    assert.equal(entry.length, 2, `malformed pin line: ${entry.join(' ')}`);
    assert.match(entry[0], /^[a-f0-9]{64}$/u, `pin must be a sha256: ${entry[0]}`);
    assert.match(entry[1], /^pnpm-[a-z0-9-]+@\d+\.\d+\.\d+$/u, `pin key must be <asset>@<version>: ${entry[1]}`);
  }
  assert.ok(
    entries.some(([, key]) => key === `pnpm-linux-x64@${version}`),
    `.github/pnpm-standalone.sha256 lacks pnpm-linux-x64@${version}; bump it together with packageManager`,
  );
});

test('setup-pnpm 只从 GitHub Releases 拉固定二进制、校验 sha256 并按版本缓存', () => {
  assert.match(action, /using: composite/u);
  assert.match(action, /"packageManager":\[\[:space:\]\]\*"pnpm@/u);
  assert.match(action, /https:\/\/github\.com\/pnpm\/pnpm\/releases\/download\/v\$\{PNPM_VERSION\}\/\$\{PNPM_ASSET\}/u);
  assert.match(action, /sha256sum "\$PNPM_DIR\/pnpm"/u);
  assert.match(action, /uses: actions\/cache@v6/u);
  assert.match(action, /key: pnpm-standalone-v1-\$\{\{ runner\.os \}\}-\$\{\{ steps\.resolve\.outputs\.asset \}\}-\$\{\{ steps\.resolve\.outputs\.version \}\}/u);
  assert.match(action, /echo "\$PNPM_DIR" >> "\$GITHUB_PATH"/u);
  assert.doesNotMatch(action, /npm (?:install|ci|i) |registry\.npmjs\.org|corepack|pnpm\/action-setup/u);
  // 摘要不匹配或版本不匹配都必须失败，而不是带着未知二进制继续。
  assert.match(action, /pnpm binary digest mismatch/u);
  assert.match(action, /pnpm reported \$installed, expected \$PNPM_VERSION/u);
});

test('所有 workflow 都改用固定二进制安装 pnpm', () => {
  for (const name of [
    'ci.yml',
    'acs-sandbox.yml',
    'deploy-staging.yml',
    'promote-release.yml',
    'staging-acceptance.yml',
    'confirm-expand-migration.yml',
  ]) {
    const workflow = readFileSync(new URL(`.github/workflows/${name}`, root), 'utf8');
    assert.doesNotMatch(workflow, /pnpm\/action-setup/u, `${name} still bootstraps pnpm via npm registry`);
    assert.match(workflow, /uses: \.\/\.github\/actions\/setup-pnpm/u, `${name} does not use setup-pnpm`);
  }
});
