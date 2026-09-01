#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import manifestModule from './release-manifest.cjs';

const { validateManifestSchema } = manifestModule;
const OID = /^[0-9a-f]{40}$/u;
const RC_TAG = /^mobile-v([0-9]+\.[0-9]+\.[0-9]+)-rc\.([1-9][0-9]*)$/u;
const PROFILE = new Set(['ios-store', 'android-store', 'android-enterprise']);
function fail(message) {
  throw new Error(`[M60-04] source authorization failed: ${message}`);
}
function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function digest(path) {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}
function args(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--') || !argv[i + 1])
      fail(`invalid argument ${argv[i] ?? '<missing>'}`);
    result[argv[i].slice(2)] = argv[++i];
  }
  return result;
}
function text(value, name) {
  if (typeof value !== 'string' || !value) fail(`${name} is required`);
  return value;
}
function readJson(path, name) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail(`${name} is not valid JSON`);
  }
}
function ensureAncestor(cwd, commit, mainRef) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', commit, mainRef], { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
function latestReviewState(reviews, login) {
  return reviews
    .filter((review) => review.user?.login === login)
    .sort((a, b) => Date.parse(b.submitted_at) - Date.parse(a.submitted_at))[0]?.state;
}

export function authorizeReleaseSource(options) {
  const root = resolve(text(options.root, 'root'));
  const commitOid = text(options.commitOid, 'commitOid').toLowerCase();
  if (!OID.test(commitOid)) fail('commitOid must be a complete lowercase SHA');
  const head = git(['rev-parse', 'HEAD'], root).toLowerCase();
  if (head !== commitOid)
    fail(`checked out HEAD ${head} does not equal requested commit ${commitOid}`);
  const dirty = git(['status', '--porcelain=v1', '--untracked-files=all'], root);
  if (dirty) fail('working tree is not clean');
  const lockPath = resolve(root, 'pnpm-lock.yaml');
  const manifestPath = resolve(root, 'mobile/release-manifest.json');
  const manifest = validateManifestSchema(readJson(manifestPath, 'release manifest'));
  const profile = text(options.profile, 'profile');
  if (!PROFILE.has(profile)) fail(`unsupported profile ${profile}`);
  if (manifest.target.profile !== 'production')
    fail('release manifest target.profile must be production');
  if (manifest.target.gitSha?.toLowerCase() !== commitOid)
    fail('release manifest target.gitSha does not match commitOid');
  if (Object.values(manifest.verification).some((state) => state !== 'verified'))
    fail('release manifest verification is incomplete');
  if (!manifest.oauthCallback.profiles.production.length)
    fail('release manifest production OAuth callback is missing');
  if (!manifest.version.androidVersionCode || !manifest.version.iosBuildNumber)
    fail('release manifest build versions are incomplete');
  const expectedDistribution =
    profile === 'android-store' ? 'store' : profile === 'android-enterprise' ? 'enterprise' : null;
  if (
    expectedDistribution &&
    ![expectedDistribution, 'both'].includes(manifest.target.distribution)
  )
    fail(`release manifest does not authorize ${expectedDistribution}`);

  let tag = null;
  let ref;
  let reviewedHeadOid = commitOid;
  if (options.tag) {
    tag = text(options.tag, 'tag');
    if (!RC_TAG.test(tag)) fail('tag must match mobile-v<semver>-rc.<positive integer>');
    const tagRef = `refs/tags/${tag}`;
    let tagType;
    try {
      tagType = git(['cat-file', '-t', tagRef], root);
    } catch {
      fail(`tag ${tag} does not exist`);
    }
    if (tagType !== 'tag') fail('RC tag must be annotated, not lightweight');
    const peeled = git(['rev-parse', `${tagRef}^{commit}`], root).toLowerCase();
    if (peeled !== commitOid) fail('RC tag does not resolve to commitOid');
    if (!ensureAncestor(root, commitOid, options.mainRef ?? 'origin/main'))
      fail('RC tag commit is not contained in target main');
    const tagVersion = RC_TAG.exec(tag)[1];
    if (tagVersion !== manifest.version.marketingVersion)
      fail('RC tag version does not match release manifest marketingVersion');
    ref = tagRef;
  } else {
    reviewedHeadOid = text(options.reviewedHeadOid, 'reviewedHeadOid').toLowerCase();
    if (!OID.test(reviewedHeadOid) || reviewedHeadOid !== commitOid)
      fail('reviewedHeadOid must exactly equal commitOid');
    if (ensureAncestor(root, commitOid, options.mainRef ?? 'origin/main')) {
      ref = options.mainRef?.startsWith('refs/') ? options.mainRef : 'refs/heads/main';
    } else {
      const pull = options.pull;
      const reviews = options.reviews;
      if (!pull || !Array.isArray(reviews))
        fail('non-main commit requires authoritative PR and review API records');
      if (pull.state !== 'open' || pull.draft === true)
        fail('target PR must be open and not draft');
      if (pull.head?.sha?.toLowerCase() !== commitOid)
        fail('target PR head is not exactly commitOid');
      if (pull.base?.ref !== 'main') fail('target PR base must be main');
      const approved = [
        ...new Set(
          reviews
            .filter((review) => review.user?.login && review.user.login !== pull.user?.login)
            .map((review) => review.user.login),
        ),
      ].filter((login) => latestReviewState(reviews, login) === 'APPROVED');
      if (!approved.length) fail('target PR has no current non-author approval');
      ref = `refs/pull/${pull.number}/head`;
    }
  }

  return Object.freeze({
    repo: text(options.repo, 'repo'),
    ref,
    tag,
    commitOid,
    reviewedHeadOid,
    lockSha256: digest(lockPath),
    manifestSha256: digest(manifestPath),
    profile,
    appId:
      profile === 'ios-store'
        ? manifest.identity.iosBundleIdentifier
        : manifest.identity.androidPackage,
    version: manifest.version.marketingVersion,
    buildNumber: profile === 'ios-store' ? manifest.version.iosBuildNumber : null,
    versionCode: profile === 'ios-store' ? null : manifest.version.androidVersionCode,
  });
}

async function main() {
  const input = args(process.argv.slice(2));
  const result = authorizeReleaseSource({
    root: input.root ?? '.',
    repo: input.repo,
    commitOid: input.commit,
    profile: input.profile,
    tag: input.tag || null,
    reviewedHeadOid: input['reviewed-head'],
    mainRef: input['main-ref'] ?? 'origin/main',
    pull: input['pull-json'] ? readJson(input['pull-json'], 'PR record') : null,
    reviews: input['reviews-json'] ? readJson(input['reviews-json'], 'reviews record') : null,
  });
  writeFileSync(resolve(text(input.output, 'output')), `${JSON.stringify(result, null, 2)}\n`, {
    mode: 0o600,
  });
  process.stdout.write(
    `M60-04 source authorized profile=${result.profile} commit=${result.commitOid}\n`,
  );
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
