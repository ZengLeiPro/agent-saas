import {
  CHAT_SUBMISSION_V1_CAPABILITY,
  parseCanonicalChatSubmission,
  type CanonicalChatSubmission,
  type ChatSubmissionIssue,
} from '@agent/shared/lib/chatSubmission';
import type { AgentTarget } from '@agent/shared';

import type { UploadedFileInfo } from '../../types/index.js';
import type { ChatRejectReasonCode, WsChatMessage } from './wsTypes.js';

export interface AdaptedWebChatSubmission {
  protocol: 'canonical_v1' | 'legacy_n_minus_1';
  clientMsgId?: string;
  text: string;
  sessionId?: string;
  deliveryMode: 'queue' | 'steer';
  model?: string;
  sandboxProfile?: 'daily' | 'coding';
  orgAgentId?: string;
  agentTarget?: AgentTarget;
  canonical?: CanonicalChatSubmission;
  legacyAttachments?: UploadedFileInfo[];
  issue?: ChatSubmissionIssue;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Thin WS boundary adapter. Canonical validation lives in shared; legacy fields are isolated here.
 */
export function adaptWebChatSubmission(msg: WsChatMessage): AdaptedWebChatSubmission {
  const raw = msg as unknown as Record<string, unknown>;
  const capabilities = Array.isArray(raw.clientCapabilities) ? raw.clientCapabilities : [];
  const declaresV1 = capabilities.includes(CHAT_SUBMISSION_V1_CAPABILITY);
  if (declaresV1) {
    const parsed = parseCanonicalChatSubmission(raw.submission);
    if (parsed.ok) {
      return {
        protocol: 'canonical_v1',
        clientMsgId: parsed.value.clientMsgId,
        text: parsed.value.text,
        sessionId: parsed.value.target.sessionId,
        deliveryMode: parsed.value.deliveryMode,
        model: parsed.value.model,
        sandboxProfile: parsed.value.target.sandboxProfile,
        orgAgentId: parsed.value.target.agentTarget?.kind === 'org-agent'
          ? parsed.value.target.agentTarget.orgAgentId
          : parsed.value.target.orgAgentId,
        agentTarget: parsed.value.target.agentTarget,
        canonical: parsed.value,
      };
    }
    const rawSubmission = raw.submission && typeof raw.submission === 'object'
      ? raw.submission as Record<string, unknown>
      : undefined;
    return {
      protocol: 'canonical_v1',
      clientMsgId: stringValue(rawSubmission?.clientMsgId) ?? stringValue(raw.client_msg_id),
      text: typeof rawSubmission?.text === 'string' ? rawSubmission.text : '',
      deliveryMode: rawSubmission?.deliveryMode === 'steer' ? 'steer' : 'queue',
      issue: parsed.issue,
    };
  }

  return {
    protocol: 'legacy_n_minus_1',
    clientMsgId: stringValue(raw.client_msg_id),
    text: typeof raw.message === 'string' ? raw.message : '',
    sessionId: stringValue(raw.sessionId),
    deliveryMode: raw.deliveryMode === 'steer' ? 'steer' : 'queue',
    model: stringValue(raw.model),
    sandboxProfile: raw.sandboxProfile === 'daily' || raw.sandboxProfile === 'coding'
      ? raw.sandboxProfile
      : undefined,
    orgAgentId: stringValue(raw.orgAgentId),
    legacyAttachments: Array.isArray(raw.attachments)
      ? raw.attachments as UploadedFileInfo[]
      : undefined,
  };
}

export function chatSubmissionIssueReasonCode(issue: ChatSubmissionIssue): ChatRejectReasonCode {
  if (issue.code === 'attachment_id_missing') return 'attachment_id_missing';
  if (issue.code === 'attachment_id_invalid') return 'attachment_id_invalid';
  return 'invalid_submission';
}
