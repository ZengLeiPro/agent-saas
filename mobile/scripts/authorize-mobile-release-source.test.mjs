import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { authorizeReleaseSource } from './authorize-mobile-release-source.mjs';

const KEY = 'fixture-release-metadata-key-32-bytes-minimum';

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function manifest(gitSha) {
  return {
    schemaVersion: 4,
    identity: {
      displayName: 'Agent SaaS',
      slug: 'agent-saas',
      scheme: 'agent-saas',
      iosBundleIdentifier: 'com.agentsaas.mobile',
      iosAscAppId: '6808382989',
      iosAppleTeamId: 'T4D4M5B485',
      iosAppGroupIdentifier: 'group.com.agentsaas.mobile.share',
      androidPackage: 'com.agentsaas.mobile',
      easProjectId: '2995ef56-aea4-4a59-ae4e-9ec3f203651a',
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
      enabled: {
        development: true,
        preview: true,
        production: true,
      },
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
  const metadata = mkdtempSync(join(tmpdir(), 'm60-04-metadata-'));
  mkdirSync(join(root, 'mobile'));
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'fixture']);
  git(root, ['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\nsnapshots: {}\n');
  writeFileSync(join(root, 'mobile/source.ts'), 'export const source = 1;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'reviewed source']);
  const head = git(root, ['rev-parse', 'HEAD']);
  git(root, ['update-ref', 'refs/remotes/origin/main', head]);
  return { root, metadata, head };
}

function signedMetadata(metadata, gitSha, mutate = (value) => value) {
  const manifestPath = join(metadata, 'release-manifest.json');
  const signaturePath = join(metadata, 'release-manifest.hmac');
  const raw = `${JSON.stringify(mutate(manifest(gitSha)), null, 2)}\n`;
  writeFileSync(manifestPath, raw);
  writeFileSync(
    signaturePath,
    `sha256:${createHmac('sha256', KEY).update(raw).digest('hex')}\n`,
  );
  return { manifestPath, manifestSignaturePath: signaturePath };
}

function authorizedOptions(root, metadata, head, extra = {}) {
  return {
    root,
    repo: 'kaiyan/agent-saas',
    commitOid: head,
    reviewedHeadOid: head,
    profile: 'android-store',
    mainRef: 'refs/remotes/origin/main',
    manifestHmacKey: KEY,
    ...signedMetadata(metadata, head),
    ...extra,
  };
}

function cleanup(value) {
  rmSync(value.root, { recursive: true, force: true });
  rmSync(value.metadata, { recursive: true, force: true });
}

test('M60-04 signed external metadata authorizes an exact main source commit', () => {
  const value = fixture();
  try {
    const result = authorizeReleaseSource(authorizedOptions(value.root, value.metadata, value.head));
    assert.equal(result.commitOid, value.head);
    assert.equal(result.reviewedHeadOid, value.head);
    assert.equal(result.ref, 'refs/remotes/origin/main');
    assert.match(result.manifestSha256, /^sha256:[0-9a-f]{64}$/u);
  } finally {
    cleanup(value);
  }
});

test('M60-04 signed external metadata authorizes an approved exact PR head', () => {
  const value = fixture();
  try {
    writeFileSync(join(value.root, 'mobile/source.ts'), 'export const source = 2;\n');
    git(value.root, ['add', '.']);
    git(value.root, ['commit', '-m', 'approved candidate']);
    const head = git(value.root, ['rev-parse', 'HEAD']);
    const result = authorizeReleaseSource(authorizedOptions(value.root, value.metadata, head, {
      pull: {
        number: 42,
        state: 'open',
        draft: false,
        user: { login: 'author' },
        head: { sha: head },
        base: { ref: 'main' },
      },
      reviews: [
        { user: { login: 'reviewer' }, state: 'APPROVED', submitted_at: '2026-09-01T00:00:00Z' },
      ],
    }));
    assert.equal(result.ref, 'refs/pull/42/head');
    assert.equal(result.commitOid, head);
  } finally {
    cleanup(value);
  }
});

test('M60-04 annotated RC tag, source SHA and signed metadata must agree', () => {
  const value = fixture();
  try {
    git(value.root, ['tag', '-a', 'mobile-v1.9.5-rc.1', '-m', 'RC', value.head]);
    const result = authorizeReleaseSource(authorizedOptions(value.root, value.metadata, value.head, {
      tag: 'mobile-v1.9.5-rc.1',
    }));
    assert.equal(result.ref, 'refs/tags/mobile-v1.9.5-rc.1');
    assert.equal(result.tag, 'mobile-v1.9.5-rc.1');
  } finally {
    cleanup(value);
  }
});

test('M60-04 rejects tampered or checkout-local release metadata', () => {
  const value = fixture();
  try {
    const options = authorizedOptions(value.root, value.metadata, value.head);
    writeFileSync(options.manifestPath, `${JSON.stringify(manifest('2'.repeat(40)))}\n`);
    assert.throws(() => authorizeReleaseSource(options), /signature is invalid/);

    const localManifest = join(value.root, 'mobile/release-manifest.external.json');
    const localSignature = join(value.root, 'mobile/release-manifest.external.hmac');
    writeFileSync(localManifest, '{}\n');
    writeFileSync(localSignature, `sha256:${'0'.repeat(64)}\n`);
    git(value.root, ['add', '.']);
    git(value.root, ['commit', '-m', 'local metadata must be rejected']);
    const localHead = git(value.root, ['rev-parse', 'HEAD']);
    git(value.root, ['update-ref', 'refs/remotes/origin/main', localHead]);
    assert.throws(() => authorizeReleaseSource(authorizedOptions(value.root, value.metadata, localHead, {
      manifestPath: localManifest,
      manifestSignaturePath: localSignature,
    })), /independent files outside the source checkout/);
  } finally {
    cleanup(value);
  }
});

test('M60-04 unreviewed non-main SHA fails closed', () => {
  const value = fixture();
  try {
    writeFileSync(join(value.root, 'mobile/source.ts'), 'export const source = 3;\n');
    git(value.root, ['add', '.']);
    git(value.root, ['commit', '-m', 'unreviewed candidate']);
    const head = git(value.root, ['rev-parse', 'HEAD']);
    assert.throws(() => authorizeReleaseSource(authorizedOptions(value.root, value.metadata, head, {
      pull: {
        number: 42,
        state: 'open',
        draft: false,
        user: { login: 'author' },
        head: { sha: head },
        base: { ref: 'main' },
      },
      reviews: [],
    })), /no current non-author approval/);
  } finally {
    cleanup(value);
  }
});

test('M60-04 dirty worktree and reviewed-head mismatch fail before any build', () => {
  const value = fixture();
  try {
    assert.throws(() => authorizeReleaseSource(authorizedOptions(value.root, value.metadata, value.head, {
      reviewedHeadOid: '2'.repeat(40),
    })), /reviewedHeadOid/);
    writeFileSync(join(value.root, 'untracked'), 'x');
    assert.throws(
      () => authorizeReleaseSource(authorizedOptions(value.root, value.metadata, value.head)),
      /working tree is not clean/,
    );
  } finally {
    cleanup(value);
  }
});
