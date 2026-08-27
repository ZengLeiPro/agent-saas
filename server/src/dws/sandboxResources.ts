import type { WorkspaceRef } from '../agent/toolRuntime.js';

/** Approved default for standalone DWS connector workspaces (daily: 1C2G). */
export const DWS_CONNECTOR_SANDBOX_RESOURCES = Object.freeze({
  cpu: '1',
  memoryMb: 2048,
}) satisfies NonNullable<WorkspaceRef['sandboxResources']>;
