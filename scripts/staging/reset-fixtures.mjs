#!/usr/bin/env node
const [baseUrl, token, releaseId] = process.argv.slice(2);
if (!baseUrl || !token || !/^rc-\d{8}-\d{2,}$/u.test(releaseId ?? ''))
  throw new Error('usage: reset-fixtures.mjs <api-base-url> <admin-token> <release-id>');

const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const inventoryResponse = await fetch(`${baseUrl}/api/admin/runtime-operations/acs/sandboxes`, {
  headers,
});
if (!inventoryResponse.ok)
  throw new Error(`Unable to list Staging sandboxes: ${inventoryResponse.status}`);
const inventory = await inventoryResponse.json();
const items = Array.isArray(inventory.items)
  ? inventory.items
  : Array.isArray(inventory.sandboxes)
    ? inventory.sandboxes
    : [];
const targets = items.filter((item) =>
  [item.name, item.workspaceId, item.sessionId].some((value) =>
    String(value ?? '').includes(releaseId),
  ),
);
for (const target of targets) {
  const response = await fetch(
    `${baseUrl}/api/admin/runtime-operations/acs/sandboxes/${encodeURIComponent(target.name)}`,
    { method: 'DELETE', headers },
  );
  if (!response.ok && response.status !== 404)
    throw new Error(`Unable to delete Staging sandbox ${target.name}: ${response.status}`);
}
const cleanup = await fetch(`${baseUrl}/api/admin/runtime-operations/acs/lifecycle-cleanup`, {
  method: 'POST',
  headers,
  body: '{}',
});
if (!cleanup.ok) throw new Error(`Staging lifecycle cleanup failed: ${cleanup.status}`);
process.stdout.write(
  `${JSON.stringify({ releaseId, deletedSandboxes: targets.map((item) => item.name), cleanup: 'ok' })}\n`,
);
