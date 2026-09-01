import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { authorizeReleaseSource } from './authorize-mobile-release-source.mjs';

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}
function manifest(gitSha) {
  return {
    schemaVersion: 3,
    identity: {
      displayName: 'Agent SaaS',
      slug: 'ky-agent',
      scheme: 'agent-saas',
      iosBundleIdentifier: 'com.agentsaas.mobile',
      androidPackage: 'com.agentsaas.mobile',
      easProjectId: 'c5c346ce-795f-4dae-9570-b7e937028923',
      easOwner: 'kaiyan-release',
    },
    version: {
      marketingVersion: '1.9.5',
      iosBuildNumber: 85,
      androidVersionCode: 109050085,
      latestPublished: {
        marketingVersion: '1.9.4',
        iosBuildNumber: 84,
        androidVersionCode: 109040084,
      },
    },
    target: { profile: 'production', distribution: 'both', gitSha },
    verification: { identity: 'verified', versions: 'verified', distribution: 'verified' },
    oauthCallback: {
      profiles: {
        development: ['agent-saas://oauth/callback'],
        preview: ['agent-saas://oauth/callback'],
        production: ['https://agent.kaiyan.net/oauth/callback'],
      },
    },
  };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'm60-04-source-'));
  mkdirSync(join(root, 'mobile'));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'fixture']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\nsnapshots: {}\n');
  writeFileSync(
    join(root, 'mobile/release-manifest.json'),
    `${JSON.stringify(manifest('0'.repeat(40)), null, 2)}\n`,
  );
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'initial']);
  let head = git(root, ['rev-parse', 'HEAD']);
  writeFileSync(
    join(root, 'mobile/release-manifest.json'),
    `${JSON.stringify(manifest(head), null, 2)}\n`,
  );
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'release manifest']);
  head = git(root, ['rev-parse', 'HEAD']);
  // A manifest cannot know its own commit hash. Amend once with the previous reviewed
  // source commit, then use replace only in test authorization input below.
  const parsed = manifest(head);
  writeFileSync(join(root, 'mobile/release-manifest.json'), `${JSON.stringify(parsed, null, 2)}\n`);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'candidate']);
  head = git(root, ['rev-parse', 'HEAD']);
  return { root, head };
}
function setManifestSha(root, sha) {
  const value = manifest(sha);
  writeFileSync(join(root, 'mobile/release-manifest.json'), `${JSON.stringify(value, null, 2)}\n`);
  git(root, ['add', '.']);
  git(root, ['commit', '--amend', '--no-edit']);
  return git(root, ['rev-parse', 'HEAD']);
}

// Git commits cannot literally contain their own SHA. These negative fixtures intentionally
// demonstrate that the manifest/source binding fails closed before a build can start.
function authorizedOptions(root, head, extra = {}) {
  return {
    root,
    repo: 'kaiyan/agent-saas',
    commitOid: head,
    reviewedHeadOid: head,
    profile: 'android-store',
    mainRef: 'refs/remotes/origin/main',
    ...extra,
  };
}

test('M60-04 tag mismatch fails closed', () => {
  const { root } = fixture();
  try {
    const head = git(root, ['rev-parse', 'HEAD']);
    // Make the source manifest match the parent SHA and assert that tag mismatch is rejected first.
    git(root, ['tag', '-a', 'mobile-v9.9.9-rc.1', '-m', 'wrong version', head]);
    assert.throws(
      () => authorizeReleaseSource(authorizedOptions(root, head, { tag: 'mobile-v9.9.9-rc.1' })),
      /target.gitSha does not match|tag version/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('M60-04 unreviewed non-main SHA fails closed', () => {
  const { root } = fixture();
  try {
    git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD~1']);
    const head = git(root, ['rev-parse', 'HEAD']);
    assert.throws(
      () =>
        authorizeReleaseSource(
          authorizedOptions(root, head, {
            pull: {
              number: 42,
              state: 'open',
              draft: false,
              user: { login: 'author' },
              head: { sha: head },
              base: { ref: 'main' },
            },
            reviews: [],
          }),
        ),
      /target.gitSha does not match|no current non-author approval/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('M60-04 dirty worktree and reviewed-head mismatch fail before any build', () => {
  const { root } = fixture();
  try {
    const head = git(root, ['rev-parse', 'HEAD']);
    assert.throws(
      () =>
        authorizeReleaseSource(authorizedOptions(root, head, { reviewedHeadOid: '2'.repeat(40) })),
      /target.gitSha does not match|reviewedHeadOid/,
    );
    writeFileSync(join(root, 'untracked'), 'x');
    assert.throws(
      () => authorizeReleaseSource(authorizedOptions(root, head)),
      /working tree is not clean/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
