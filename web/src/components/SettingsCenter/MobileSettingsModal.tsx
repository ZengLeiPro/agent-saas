import { Settings2 } from 'lucide-react';

import {
  managementPagesFor,
  managementRouteForPage,
} from '@/lib/managementNavigation';
import { navigateSettingsRoute } from '@/lib/urlSync';
import type { GovernanceRouteState } from '@/lib/governanceNavigation';
import type { SettingsModalProps } from './SettingsModal';
import { SettingsModal } from './SettingsEntry';

interface MobileSettingsModalProps extends Omit<SettingsModalProps, 'managementGroups'> {
  governanceRoute: GovernanceRouteState | null;
  managementStatus: 'loading' | 'refreshing' | 'ready' | 'error';
  tenantEntryAllowed: boolean;
  platformEntryAllowed: boolean;
  organizationTargetId?: string | null;
}

export default function MobileSettingsModal({
  governanceRoute,
  managementStatus,
  tenantEntryAllowed,
  platformEntryAllowed,
  organizationTargetId,
  ...settingsProps
}: MobileSettingsModalProps) {
  const ready = managementStatus === 'ready' || managementStatus === 'refreshing';
  const managementGroups = [
    ...(ready && tenantEntryAllowed
      ? [{
          id: 'tenant',
          label: '组织管理',
          items: managementPagesFor('config', 'organization').map((page) => ({
            id: page.id,
            label: page.label,
            icon: Settings2,
            onSelect: () => navigateSettingsRoute(managementRouteForPage(page, governanceRoute, organizationTargetId)),
          })),
        }]
      : []),
    ...(ready && platformEntryAllowed
      ? [{
          id: 'platform',
          label: '平台运营',
          items: managementPagesFor('config', 'platform').map((page) => ({
            id: page.id,
            label: page.label,
            icon: Settings2,
            onSelect: () => navigateSettingsRoute(managementRouteForPage(page, governanceRoute)),
          })),
        }]
      : []),
  ];

  return <SettingsModal {...settingsProps} managementGroups={managementGroups} />;
}
