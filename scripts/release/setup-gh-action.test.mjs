import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const action = readFileSync(new URL('.github/actions/setup-gh/action.yml', root), 'utf8');
const pins = readFileSync(new URL('.github/actions/setup-gh/sha256sums.txt', root), 'utf8');

const DEFAULT_VERSION = '2.101.0';

test('setup-gh 默认版本在 action 旁的校验和清单里有记录', () => {
  assert.match(action, new RegExp(`default: '${DEFAULT_VERSION}'`, 'u'));
  const entries = pins
    .split(/\r?\n/u)
    .filter((line) => line.trim() && !line.startsWith('#'))
    .map((line) => line.trim().split(/\s+/u));
  for (const entry of entries) {
    assert.equal(entry.length, 2, `malformed pin line: ${entry.join(' ')}`);
    assert.match(entry[0], /^[a-f0-9]{64}$/u, `pin must be a sha256: ${entry[0]}`);
    assert.match(
      entry[1],
      /^gh_\d+\.\d+\.\d+_linux_(amd64|arm64)@\d+\.\d+\.\d+$/u,
      `pin key must be <asset>@<version>: ${entry[1]}`,
    );
  }
  assert.ok(
    entries.some(([, key]) => key === `gh_${DEFAULT_VERSION}_linux_amd64@${DEFAULT_VERSION}`),
    `sha256sums.txt lacks gh_${DEFAULT_VERSION}_linux_amd64@${DEFAULT_VERSION}`,
  );
  assert.ok(
    entries.some(([, key]) => key === `gh_${DEFAULT_VERSION}_linux_arm64@${DEFAULT_VERSION}`),
    `sha256sums.txt lacks gh_${DEFAULT_VERSION}_linux_arm64@${DEFAULT_VERSION}`,
  );
});

test('setup-gh 只从 GitHub Releases 拉固定二进制、校验 sha256 并按版本缓存', () => {
  assert.match(action, /using: composite/u);
  assert.match(action, /GITHUB_ACTION_PATH\/sha256sums\.txt/u);
  assert.match(
    action,
    /https:\/\/github\.com\/cli\/cli\/releases\/download\/v\$\{GH_SETUP_VERSION\}\/\$\{GH_SETUP_ARCHIVE\}/u,
  );
  assert.match(action, /sha256sum "\$GH_SETUP_DIR\/gh"/u);
  assert.match(action, /uses: actions\/cache@v6/u);
  assert.match(
    action,
    /key: gh-cli-v1-\$\{\{ runner\.os \}\}-\$\{\{ steps\.resolve\.outputs\.asset \}\}-\$\{\{ steps\.resolve\.outputs\.version \}\}/u,
  );
  assert.match(action, /echo "\$GH_SETUP_DIR" >> "\$GITHUB_PATH"/u);
  assert.doesNotMatch(action, /cli\/cli-setup|advanced-security\/gh|apt-get install.*gh/u);
  assert.match(action, /gh binary digest mismatch/u);
  assert.match(action, /gh reported \$installed, expected \$GH_SETUP_VERSION/u);
});

test('需要 gh 的 kaiyan-linux job 在首次调用前配置 setup-gh', () => {
  const setupGhRef =
    /uses: (?:\.\/|ZengLeiPro\/agent-saas\/)\.github\/actions\/setup-gh(?:@main)?/u;

  const cases = [
    {
      file: 'deploy-staging.yml',
      jobs: [
        'guard',
        'ensure-evidence-writer',
        'prepare-evidence',
        'prepare-acs',
        'promote-production',
        'build-deploy-verify',
      ],
    },
    { file: 'promote-release.yml', jobs: ['promote'] },
    { file: 'ci.yml', jobs: ['retire_legacy_workflows'] },
  ];

  for (const { file, jobs: expectedJobs } of cases) {
    const workflow = readFileSync(new URL(`.github/workflows/${file}`, root), 'utf8');
    const parts = workflow.split(/\n(?=  [a-zA-Z0-9_-]+:\n)/u);
    const found = new Map();
    for (const part of parts) {
      const name = /^  ([a-zA-Z0-9_-]+):/u.exec(part)?.[1];
      if (!name || !part.includes('runs-on: kaiyan-linux')) continue;
      if (!expectedJobs.includes(name)) continue;
      found.set(name, part);
      assert.match(part, setupGhRef, `${file} job ${name} missing setup-gh`);
      const setupAt = part.search(setupGhRef);
      const usageMarkers = [
        /(?<![\w./-])gh (?:api|run|release|workflow)\b/u,
        /automatic-release-child\.mjs/u,
        /retire-legacy-workflows\.mjs/u,
      ];
      let firstUse = -1;
      for (const re of usageMarkers) {
        const m = re.exec(part);
        if (m && (firstUse < 0 || m.index < firstUse)) firstUse = m.index;
      }
      assert.ok(
        firstUse < 0 || setupAt < firstUse,
        `${file} job ${name}: setup-gh must precede first gh usage`,
      );
    }
    for (const name of expectedJobs) {
      assert.ok(found.has(name), `${file} missing expected kaiyan job ${name}`);
    }
  }
});
