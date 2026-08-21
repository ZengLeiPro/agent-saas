import { resolve } from 'node:path';

import type { ExecutionTargetKind } from '../agent/toolRuntime.js';
import { getAgentTranscriptDir } from '../data/transcripts/projectKey.js';
import type { ChannelContext } from '../types/index.js';
import {
  DEFAULT_SANDBOX_DENY_READ,
  expandSandboxPaths,
  type SandboxExpandContext,
} from '../engine/sandbox.js';

interface RawRuntimeSandboxConfig {
  agentCwd: string;
  sharedDir: string;
  dispatch?: { sandbox?: { denyRead?: string[] } };
}

export function buildRawRuntimeSandboxPolicy(
  config: RawRuntimeSandboxConfig,
  context: ChannelContext,
  cwd: string,
  executionTarget: ExecutionTargetKind,
): { denyRead: string[] } | undefined {
  if (executionTarget !== 'server-local') return undefined;
  const identity = context.sessionOwner ?? context.user;
  if (!identity || !config.agentCwd || !config.sharedDir) return undefined;
  const agentTranscriptDir = identity.id && identity.tenantId
    ? getAgentTranscriptDir({ tenantId: identity.tenantId, userId: identity.id })
    : undefined;
  const sandboxCtx: SandboxExpandContext = {
    username: identity.username,
    userCwd: cwd,
    tenantCwd: resolve(cwd, '..'),
    workspaceRoot: config.agentCwd,
    sharedDir: config.sharedDir,
    ...(agentTranscriptDir ? { agentTranscriptDir } : {}),
  };
  const denyRead = expandSandboxPaths(
    config.dispatch?.sandbox?.denyRead ?? DEFAULT_SANDBOX_DENY_READ,
    sandboxCtx,
  );
  return { denyRead };
}
