import assert from 'node:assert/strict';
import test from 'node:test';

import { deleteSandboxAfterBusyRelease } from './reset-fixtures-lib.mjs';

test('waits for an exact busy response before deleting the Sandbox', async () => {
  const statuses = [409, 409, 204];
  const delays = [];
  const requests = [];
  await deleteSandboxAfterBusyRelease({
    baseUrl: 'https://staging-agent-api.kaiyan.net',
    name: 'as-e2e-sandbox',
    headers: { authorization: 'Bearer test' },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(null, { status: statuses.shift() });
    },
    waitForRetry: async (delay) => delays.push(delay),
  });
  assert.deepEqual(delays, [2_000, 2_000]);
  assert.equal(requests.length, 3);
  assert.ok(requests.every(({ options }) => options.method === 'DELETE'));
});

test('treats an already absent Sandbox as clean', async () => {
  await deleteSandboxAfterBusyRelease({
    baseUrl: 'https://staging-agent-api.kaiyan.net',
    name: 'as-e2e-sandbox',
    headers: {},
    fetchImpl: async () => new Response(null, { status: 404 }),
    waitForRetry: async () => assert.fail('404 must not retry'),
  });
});

test('fails immediately for a non-busy deletion error', async () => {
  await assert.rejects(
    deleteSandboxAfterBusyRelease({
      baseUrl: 'https://staging-agent-api.kaiyan.net',
      name: 'as-e2e-sandbox',
      headers: {},
      fetchImpl: async () => new Response(null, { status: 500 }),
      waitForRetry: async () => assert.fail('500 must not retry'),
    }),
    /Unable to delete Staging sandbox as-e2e-sandbox: 500/u,
  );
});

test('fails closed when the Sandbox stays busy through the retry budget', async () => {
  let attempts = 0;
  await assert.rejects(
    deleteSandboxAfterBusyRelease({
      baseUrl: 'https://staging-agent-api.kaiyan.net',
      name: 'as-e2e-sandbox',
      headers: {},
      fetchImpl: async () => {
        attempts += 1;
        return new Response(null, { status: 409 });
      },
      waitForRetry: async () => {},
      maxAttempts: 3,
    }),
    /Unable to delete Staging sandbox as-e2e-sandbox: 409/u,
  );
  assert.equal(attempts, 3);
});
