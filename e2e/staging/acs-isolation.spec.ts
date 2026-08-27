import { readFile } from 'node:fs/promises';
import { expect, test } from 'playwright/test';

test('反向拒绝与共享 NAS 逻辑隔离证据完整', async () => {
  const summary = JSON.parse(await readFile(process.env.STAGING_ISOLATION_SUMMARY!, 'utf8'));
  expect(summary).toMatchObject({
    schemaVersion: 1,
    environment: 'staging',
    status: 'verified-with-accepted-residual-risk',
    residualRisks: ['privileged-host-can-remount-shared-filesystem-root'],
  });
  expect(summary.evidenceDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
});
