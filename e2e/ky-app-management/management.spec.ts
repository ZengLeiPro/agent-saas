import { test, expect } from 'playwright/test';
const manifest = {
  contractVersion: 1,
  systemId: 'e2e-business-system',
  name: '验收订单系统',
  description: '本地管理链路验收',
  roles: { adminRole: 'erp_admin' },
  pathPrefixes: { user: ['/api/app/'], admin: ['/api/admin/'] },
  capabilities: [
    {
      id: 'order.search',
      name: '查订单',
      description: '查询订单号，用于确认订单进度。',
      riskLevel: 'read_only',
      approval: 'none',
      safeToRetry: true,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { keyword: { type: 'string', maxLength: 40 } },
        required: ['keyword'],
      },
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { orderId: { type: 'string' } },
      },
    },
  ],
};
test('真实 PG 管理页面：上传、双人复核、发布、组织安装、一次性领取', async ({ page }, testInfo) => {
  page.on('dialog', (dialog) => dialog.accept());
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
    console.error(error.message);
  });
  await page.goto('/');
  await page.getByLabel('上传 Manifest JSON').setInputFiles({
    name: 'manifest.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(manifest)),
  });
  await page.getByRole('button', { name: '校验并登记版本', exact: true }).click();
  await expect(page.getByText('待复核', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '复核版本', exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('01-version-pending.png'), fullPage: true });
  await page.getByLabel('测试身份').selectOption('reviewer');
  await page.getByRole('button', { name: '复核版本', exact: true }).click();
  await expect(page.getByText('已复核', { exact: true })).toBeVisible();
  await page.locator('summary').filter({ hasText: '字段差异' }).click();
  await page.screenshot({
    path: testInfo.outputPath('02-version-diff-review.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: '发布版本', exact: true }).click();
  await expect(page.getByText('已发布', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: '系统目录', exact: true }).click();
  await expect(
    page.getByRole('cell', { name: '验收订单系统 e2e-business-system', exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('03-system-catalog.png'), fullPage: true });
  await page.getByLabel('测试身份').selectOption('org');
  await page.getByRole('link', { name: '组织系统', exact: true }).click();
  await page.getByRole('tab', { name: '可安装', exact: true }).click();
  await page.getByRole('button', { name: '安装', exact: true }).click();
  await page.getByLabel('安装实例标识', { exact: true }).fill('e2e-business-system-tenant-a');
  await page.getByLabel('业务服务地址', { exact: true }).fill('http://127.0.0.1:4195');
  await page.getByLabel('业务页面地址', { exact: true }).fill('http://127.0.0.1:4195');
  await page.getByLabel('本组织技术联系人用户 ID', { exact: true }).fill('u_member');
  await page.getByRole('button', { name: '创建安装实例', exact: true }).click();
  await expect(page.getByText('_ky-app-verify.127.0.0.1', { exact: false })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('04-installation-domain-guide.png'),
    fullPage: true,
  });
  const issued = await page.request.post(
    '/api/app-contract/v1/installations/e2e-business-system-tenant-a/credentials',
    { headers: { 'x-test-identity': 'platform' } },
  );
  expect(issued.status()).toBe(201);
  const { credential } = await issued.json();
  await page.evaluate(() => sessionStorage.setItem('p0-test-identity', 'member'));
  await page.goto(
    `/ky-app/credential-claim/e2e-business-system-tenant-a#ticket=${credential.ticket}`,
  );
  await expect(page.getByRole('button', { name: '确认风险并领取' })).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  await page.getByRole('button', { name: '确认风险并领取' }).click();
  await expect(page.getByRole('button', { name: '清除明文' })).toBeVisible();
  // 不保存领取明文截图或 trace；先销毁明文，再保存成功后的终态证据。
  const secret = await page.locator('pre').innerText();
  expect(secret).toContain('KY_SERVICE_CREDENTIAL=');
  const storage = await page.evaluate(() =>
    JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
  );
  expect(storage).not.toContain('KY_SERVICE_CREDENTIAL');
  await page.getByRole('button', { name: '清除明文' }).click();
  await expect(page.locator('pre')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('05-claim-cleared.png'), fullPage: true });
  const duplicate = await page.request.get(
    `/api/app-contract/v1/installations/e2e-business-system-tenant-a/credentials/claim/${credential.ticket}`,
    { headers: { 'x-test-identity': 'member' } },
  );
  expect(duplicate.status()).toBe(409);
  expect(errors).toEqual([]);
});
