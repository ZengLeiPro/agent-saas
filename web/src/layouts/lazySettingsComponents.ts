import { lazy } from 'react';

export const GovernanceConsole = lazy(() =>
  import('@/components/GovernanceConsole').then((module) => ({
    default: module.GovernanceConsole,
  })),
);
export const CronManager = lazy(() =>
  import('@/components/CronManager').then((module) => ({ default: module.CronManager })),
);
export const UserManager = lazy(() =>
  import('@/components/UserManager').then((module) => ({ default: module.UserManager })),
);
export const TenantManager = lazy(() =>
  import('@/components/TenantManager').then((module) => ({ default: module.TenantManager })),
);
export const SkillManagerPanel = lazy(() =>
  import('@/components/SkillManager').then((module) => ({ default: module.SkillManager })),
);
export const McpManagerPanel = lazy(() =>
  import('@/components/McpManager').then((module) => ({ default: module.McpManager })),
);
export const UsageDashboard = lazy(() =>
  import('@/components/UsageDashboard').then((module) => ({ default: module.UsageDashboard })),
);
export const EfficiencyViewPanel = lazy(() =>
  import('@/components/UsageDashboard/EfficiencyView').then((module) => ({
    default: module.EfficiencyView,
  })),
);
export const ModelManagerPanel = lazy(() =>
  import('@/components/ModelManager').then((module) => ({ default: module.ModelManager })),
);
export const TenantRemoteHandsManagerPanel = lazy(() =>
  import('@/components/TenantRemoteHandsManager').then((module) => ({
    default: module.TenantRemoteHandsManager,
  })),
);
export const ToolControlsManagerPanel = lazy(() =>
  import('@/components/ToolControlsManager').then((module) => ({
    default: module.ToolControlsManager,
  })),
);
export const SignupConfigManagerPanel = lazy(() =>
  import('@/components/SignupConfigManager').then((module) => ({
    default: module.SignupConfigManager,
  })),
);
export const MemoryPollingManagerPanel = lazy(() =>
  import('@/components/MemoryPollingManager').then((module) => ({
    default: module.MemoryPollingManager,
  })),
);
export const CompanyInfoSectionPanel = lazy(() =>
  import('@/components/CompanyInfoEditor').then((module) => ({
    default: module.CompanyInfoSection,
  })),
);
export const OrgAgentManagerPanel = lazy(() =>
  import('@/components/OrgAgentManager').then((module) => ({ default: module.OrgAgentManager })),
);
export const SettingsDirtyBoundary = lazy(() =>
  import('@/components/PersonalSettings/dirtyRegistry').then((module) => ({
    default: module.SettingsDirtyBoundary,
  })),
);
export const TenantAdminShell = lazy(() =>
  import('@/components/AdminShells').then((module) => ({ default: module.TenantAdminShell })),
);
export const PlatformAdminShell = lazy(() =>
  import('@/components/AdminShells').then((module) => ({ default: module.PlatformAdminShell })),
);
export const ManagementSettingsAccessGate = lazy(() =>
  import('@/components/ManagementSettingsAccessGate').then((module) => ({
    default: module.ManagementSettingsAccessGate,
  })),
);
