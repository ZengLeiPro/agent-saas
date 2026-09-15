import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  applyMarketingVersionToManifest,
  assertMarketingVersionAllowed,
  parseStrictSemver,
  resolvePublishedShortVersion,
  resolveReleaseMarketingVersion,
  trimMarketingVersionInput,
} from './ios-marketing-version.mjs';

test('trims marketing version input and treats whitespace-only as blank', () => {
  assert.equal(trimMarketingVersionInput(' 1.2.3 '), '1.2.3');
  assert.equal(trimMarketingVersionInput('   '), '');
  assert.equal(trimMarketingVersionInput(undefined), '');
  assert.throws(() => trimMarketingVersionInput(1));
});

test('strict SemVer rejects malformed values', () => {
  assert.equal(parseStrictSemver('1.2.3'), '1.2.3');
  assert.equal(parseStrictSemver(' 1.2.3 '), '1.2.3');
  assert.equal(parseStrictSemver('1.2.3-beta.1'), '1.2.3-beta.1');
  for (const value of ['', '1', '1.2', '01.2.3', 'v1.2.3', 'latest', '1.2.3.4']) {
    assert.throws(() => parseStrictSemver(value));
  }
});

test('filled marketing version must be >= published (equality allowed)', () => {
  assert.equal(assertMarketingVersionAllowed('1.2.3', { version: '1.2.3', source: 'live' }), '1.2.3');
  assert.equal(assertMarketingVersionAllowed('1.2.4', { version: '1.2.3', source: 'testflight' }), '1.2.4');
  assert.throws(
    () => assertMarketingVersionAllowed('1.2.2', { version: '1.2.3', source: 'live' }),
    /1\.2\.3/,
  );
  assert.equal(assertMarketingVersionAllowed('1.0.0', null), '1.0.0');
});

function fakeClient(routes) {
  return {
    async request(path) {
      const key = path.split('?')[0];
      assert.ok(Object.hasOwn(routes, path) || Object.hasOwn(routes, key), `unexpected ASC path ${path}`);
      return routes[path] ?? routes[key];
    },
  };
}

test('published short version prefers Live READY_FOR_SALE over TestFlight', async () => {
  const client = fakeClient({
    '/apps/6808382989/appStoreVersions': {
      data: [{ attributes: { versionString: '2.0.0', appStoreState: 'READY_FOR_SALE', platform: 'IOS' } }],
    },
  });
  // Route with query string — match via startsWith helper
  client.request = async (path) => {
    if (path.startsWith('/apps/6808382989/appStoreVersions')) {
      return { data: [{ attributes: { versionString: '2.0.0', appStoreState: 'READY_FOR_SALE', platform: 'IOS' } }] };
    }
    assert.fail(`unexpected ${path}`);
  };
  assert.deepEqual(await resolvePublishedShortVersion(client, '6808382989'), {
    version: '2.0.0',
    source: 'live',
  });
});

test('published short version falls back to latest usable TestFlight train', async () => {
  const client = {
    async request(path) {
      if (path.startsWith('/apps/6808382989/appStoreVersions')) return { data: [] };
      if (path.startsWith('/preReleaseVersions?')) {
        return {
          data: [
            { id: 'train-old', attributes: { version: '1.0.0', platform: 'IOS' } },
            { id: 'train-new', attributes: { version: '1.1.0', platform: 'IOS' } },
            { id: 'train-bad', attributes: { version: '9.0.0', platform: 'IOS' } },
          ],
        };
      }
      if (path.startsWith('/preReleaseVersions/train-old/builds')) {
        return { data: [{ attributes: { processingState: 'VALID', expired: false } }] };
      }
      if (path.startsWith('/preReleaseVersions/train-new/builds')) {
        return { data: [{ attributes: { processingState: 'VALID', expired: false } }] };
      }
      if (path.startsWith('/preReleaseVersions/train-bad/builds')) {
        return { data: [{ attributes: { processingState: 'VALID', expired: true } }] };
      }
      assert.fail(`unexpected ${path}`);
    },
  };
  assert.deepEqual(await resolvePublishedShortVersion(client, '6808382989'), {
    version: '1.1.0',
    source: 'testflight',
  });
});

test('first release with blank input hard-fails and never seeds 1.0.0', async () => {
  const client = {
    async request(path) {
      if (path.startsWith('/apps/1234567890/appStoreVersions')) return { data: [] };
      if (path.startsWith('/preReleaseVersions')) return { data: [] };
      assert.fail(path);
    },
  };
  await assert.rejects(
    resolveReleaseMarketingVersion('', { client, appId: '1234567890' }),
    /首次 iOS 发布|种子/,
  );
  await assert.rejects(
    resolveReleaseMarketingVersion('   ', { client, appId: '1234567890' }),
    /首次 iOS 发布|种子/,
  );
});

test('blank input uses ASC published version and never reads a provided manifest fallback', async () => {
  const client = {
    async request(path) {
      if (path.startsWith('/apps/1234567890/appStoreVersions')) {
        return { data: [{ attributes: { versionString: '3.4.5', appStoreState: 'READY_FOR_SALE', platform: 'IOS' } }] };
      }
      assert.fail(path);
    },
  };
  const resolved = await resolveReleaseMarketingVersion('', { client, appId: '1234567890' });
  assert.deepEqual(resolved, {
    marketingVersion: '3.4.5',
    source: 'live',
    published: { version: '3.4.5', source: 'live' },
    input: '',
  });
});

test('ASC failure fails closed and mentions no manifest fallback', async () => {
  const client = {
    async request() {
      throw new Error('App Store Connect request failed (HTTP 401); check the HTTP status and API key permissions in the Actions diagnostic');
    },
  };
  await assert.rejects(
    resolveReleaseMarketingVersion('1.0.0', { client, appId: '1234567890' }),
    /不会回退到 release-manifest/,
  );
});

test('filled input on first release is accepted as seed', async () => {
  const client = {
    async request(path) {
      if (path.startsWith('/apps/1234567890/appStoreVersions')) return { data: [] };
      if (path.startsWith('/preReleaseVersions')) return { data: [] };
      assert.fail(path);
    },
  };
  const resolved = await resolveReleaseMarketingVersion('1.0.0', { client, appId: '1234567890' });
  assert.equal(resolved.marketingVersion, '1.0.0');
  assert.equal(resolved.source, 'input');
  assert.equal(resolved.published, null);
});

test('applyMarketingVersionToManifest patches marketingVersion only and clears latestPublished.marketingVersion', () => {
  const root = mkdtempSync(join(tmpdir(), 'ios-mkt-'));
  try {
    mkdirSync(join(root, 'mobile'), { recursive: true });
    writeFileSync(join(root, 'mobile/release-manifest.json'), JSON.stringify({
      version: {
        marketingVersion: '0.9.0',
        iosBuildNumber: 6,
        androidVersionCode: 42,
        latestPublished: {
          marketingVersion: '0.8.0',
          iosBuildNumber: 5,
          androidVersionCode: 41,
        },
      },
    }, null, 2));
    applyMarketingVersionToManifest(root, '1.2.3');
    const manifest = JSON.parse(readFileSync(join(root, 'mobile/release-manifest.json'), 'utf8'));
    assert.equal(manifest.version.marketingVersion, '1.2.3');
    assert.equal(manifest.version.iosBuildNumber, 6);
    assert.equal(manifest.version.androidVersionCode, 42);
    assert.equal(manifest.version.latestPublished.marketingVersion, null);
    assert.equal(manifest.version.latestPublished.androidVersionCode, 41);
    assert.equal(manifest.version.latestPublished.iosBuildNumber, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
