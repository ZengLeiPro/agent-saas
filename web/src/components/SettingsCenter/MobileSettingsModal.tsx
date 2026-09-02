import { CircleGauge, Settings2, type LucideIcon } from 'lucide-react';

import {
  ORGANIZATION_SETTINGS_WORKSPACES,
  type OrganizationSettingsWorkspaceIconKey,
} from '@/components/OrganizationManagement/organizationManagementRegistry';
import { organizationWorkspaceRoute } from '@/components/OrganizationManagement/organizationManagementRouting';
import { EntityIcons } from '@/lib/icons';
import { navigateSettingsRoute } from '@/lib/urlSync';
import type { GovernanceRouteState } from '@/lib/governanceNavigation';
import { PLATFORM_SETTINGS_SECTIONS } from './unifiedSettingsConfig';
import type { SettingsModalProps } from './SettingsModal';
import { SettingsModal } from './SettingsEntry';

const ORGANIZATION_WORKSPACE_ICONS: Record<OrganizationSettingsWorkspaceIconKey, LucideIcon> = {
  overview: CircleGauge,
  members: EntityIcons.members,
  agents: EntityIcons.expert,
  governance: EntityIcons.billing,
  settings: Settings2,
};

interface MobileSettingsModalProps extends Omit<SettingsModalProps, 'managementGroups'> {
  governanceRoute: GovernanceRouteState | null;
  managementStatus: 'loading' | 'refreshing' | 'ready' | 'error';
  tenantEntryAllowed: boolean;
  platformEntryAllowed: boolean;
  openAdminSettings: (target: 'tenant' | 'platform', section?: string) => void;
}

export default function MobileSettingsModal({
  governanceRoute,
  managementStatus,
  tenantEntryAllowed,
  platformEntryAllowed,
  openAdminSettings,
  ...settingsProps
}: MobileSettingsModalProps) {
  const ready = managementStatus === 'ready' || managementStatus === 'refreshing';
  const managementGroups = [
    ...(ready && tenantEntryAllowed
      ? [
          {
            id: 'tenant',
            label: '组织管理',
            items: ORGANIZATION_SETTINGS_WORKSPACES.map((workspace) => ({
              id: workspace.id,
              label: workspace.label,
              icon: ORGANIZATION_WORKSPACE_ICONS[workspace.iconKey],
              onSelect: () =>
                navigateSettingsRoute(
                  organizationWorkspaceRoute(
                    workspace.id,
                    governanceRoute?.area === 'organization' ? governanceRoute : null,
                  ),
                ),
            })),
          },
        ]
      : []),
    ...(ready && platformEntryAllowed
      ? [
          {
            id: 'platform',
            label: '平台管理',
            items: PLATFORM_SETTINGS_SECTIONS.map((item) => ({
              ...item,
              onSelect: () => openAdminSettings('platform', item.id),
            })),
          },
        ]
      : []),
  ];

  return <SettingsModal {...settingsProps} managementGroups={managementGroups} />;
}
