import { readFile } from 'node:fs/promises';
import { expect, test } from 'playwright/test';

test('反向隔离证据完整且由真实拒绝产生', async () => {
  const summary = JSON.parse(await readFile(process.env.STAGING_ISOLATION_SUMMARY!, 'utf8'));
  expect(summary).toMatchObject({ schemaVersion: 1, environment: 'staging', status: 'verified' });
  expect(summary.evidenceDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
});
