import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@/index.css';
import { PlatformSystemsPage } from '@/components/BusinessSystems/PlatformSystemsPage';
import { OrganizationSystemsPage } from '@/components/BusinessSystems/OrganizationSystemsPage';
import { BusinessSystemOperationsPage } from '@/components/BusinessSystems/BusinessSystemOperationsPage';
import { KyAppCredentialClaimEntry } from '@/components/KyAppCredentialClaim/KyAppCredentialClaimEntry';
import { credentialClaimInstallation } from '@/components/KyAppCredentialClaim/claimRoute';
import {
  parseGovernanceUrl,
  governanceRoute,
  buildGovernanceUrl,
} from '@/lib/governanceNavigation';
function App() {
  const [location, setLocation] = useState(window.location.pathname + window.location.search);
  useEffect(() => {
    const update = () => setLocation(window.location.pathname + window.location.search);
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  const claimId = credentialClaimInstallation(window.location.pathname);
  const parsed = parseGovernanceUrl(location);
  const route = parsed.kind === 'route' ? parsed.route : null;
  return (
    <>
      <header className="flex gap-4 border-b bg-muted p-3 text-sm">
        <strong>本地验收环境 · 测试身份</strong>
        <select
          aria-label="测试身份"
          defaultValue={sessionStorage.getItem('p0-test-identity') ?? 'platform'}
          onChange={(e) => {
            sessionStorage.setItem('p0-test-identity', e.target.value);
            window.location.reload();
          }}
        >
          {['platform', 'reviewer', 'org', 'member', 'unassigned', 'other'].map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
        {[
          'platform.resource-center.business-systems',
          'organization.agents.business-systems',
          'platform.runtime.business-system-operations',
        ].map((id) => (
          <a
            key={id}
            href={buildGovernanceUrl(
              governanceRoute(id, id.startsWith('organization') ? { orgId: 't_demo' } : {}),
            )}
          >
            {id.includes('operations')
              ? '运营'
              : id.startsWith('organization')
                ? '组织系统'
                : '系统目录'}
          </a>
        ))}
      </header>
      <div className="mx-auto max-w-6xl">
        {claimId ? (
          <KyAppCredentialClaimEntry installationId={claimId} />
        ) : route?.routeId === 'organization.agents.business-systems' ? (
          <OrganizationSystemsPage
            tenantId={route.orgId ?? 't_demo'}
            installationId={route.entityId}
          />
        ) : route?.routeId === 'platform.runtime.business-system-operations' ? (
          <BusinessSystemOperationsPage installationId={route.entityId} />
        ) : (
          <PlatformSystemsPage systemId={route?.entityId} />
        )}
      </div>
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
