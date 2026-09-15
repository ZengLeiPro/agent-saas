import React from 'react';
import { createRoot } from 'react-dom/client';

import '../../src/platform/init';
import { OrganizationSystemsPage } from '../../src/components/BusinessSystems/OrganizationSystemsPage';
import '../../src/index.css';

const digest = 'd9f86cf0c0aeebab8a12f0756d87e99d97c286237c18d9c5a6371630edc256cd';
const installations = [
  {
    installationId: 'kaiyan-test-system-demo',
    tenantId: 'kaiyan-demo',
    systemId: 'kaiyan-test-system',
    systemName: '开沿测试系统',
    status: 'enabled',
    authMode: 'v2_asymmetric',
    runtimeStatus: 'healthy',
    registeredDigest: digest,
    publishedDigest: digest,
    domainVerifiedAt: '2026-09-15T08:00:00.000Z',
    updatedAt: '2026-09-15T08:52:00.000Z',
  },
  {
    installationId: 'legacy-erp-demo',
    tenantId: 'kaiyan-demo',
    systemId: 'legacy-erp',
    systemName: '旧 ERP',
    status: 'pending',
    authMode: 'v1_symmetric',
    runtimeStatus: 'unknown',
    registeredDigest: null,
    publishedDigest: digest,
    domainVerifiedAt: '2026-09-15T08:00:00.000Z',
    updatedAt: '2026-09-15T07:30:00.000Z',
  },
];

window.fetch = async (input) => {
  const pathname = new URL(String(input), location.origin).pathname;
  const data = pathname.endsWith('/installations') ? { installations, nextCursor: null } : {};
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

createRoot(document.getElementById('root')!).render(
  <main className="min-h-screen bg-background px-6 py-8">
    <div className="mx-auto max-w-6xl">
      <OrganizationSystemsPage tenantId="kaiyan-demo" />
    </div>
  </main>,
);
