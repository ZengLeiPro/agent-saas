import {
  MOUNT_SUBPATH_ANNOTATION,
  SHARED_READ_ONLY_SUBPATH_ANNOTATION,
} from './sandboxInventoryReader.js';
import type { SandboxRef } from './sandboxManagerTypes.js';
import type { SandboxStatus } from './sandboxState.js';

export function readSandboxMountPaths(
  status: SandboxStatus,
  fallbackWorkspaceId: string,
): {
  mountSubPath: string;
  sharedReadOnlySubPath?: string;
} {
  const raw = status.raw ?? {};
  const metadata = record(raw.metadata);
  const annotations = record(metadata.annotations);
  return {
    mountSubPath: text(annotations[MOUNT_SUBPATH_ANNOTATION]) ?? fallbackWorkspaceId,
    ...(text(annotations[SHARED_READ_ONLY_SUBPATH_ANNOTATION])
      ? { sharedReadOnlySubPath: text(annotations[SHARED_READ_ONLY_SUBPATH_ANNOTATION]) }
      : {}),
  };
}

export function buildWorkspaceVolumeMounts(
  ref: SandboxRef,
  workspaceMountPath: string,
): Array<{
  name: string;
  mountPath: string;
  subPath: string;
  readOnly?: boolean;
}> {
  return [
    { name: 'workspace', mountPath: workspaceMountPath, subPath: ref.mountSubPath },
    ...(ref.sharedReadOnlySubPath
      ? [
          {
            name: 'workspace',
            mountPath: '/agent-shared',
            subPath: ref.sharedReadOnlySubPath,
            readOnly: true,
          },
        ]
      : []),
  ];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}
