import {
  normalizeChatSubmissionAttachment,
  type CanonicalChatAttachment,
} from '@agent/shared';

import type { CanonicalAttachmentInfo, UploadedFileInfo } from '../../types/index.js';
import type { UploadManager } from '../../uploads/manager.js';
import type { AdaptedWebChatSubmission } from './chatSubmissionAdapter.js';

export class ChatAttachmentResolutionError extends Error {
  constructor(
    readonly reason: 'not_found' | 'state_unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'ChatAttachmentResolutionError';
  }
}

export interface ResolvedChatSubmissionAttachments {
  /** Server-authoritative state, including a trusted materialization path. */
  materialized: UploadedFileInfo[];
  /** Path-free authority persisted in submission/queue/replay snapshots. */
  canonical: CanonicalChatAttachment[];
}

function canonicalizeResolvedAttachment(
  attachment: UploadedFileInfo,
  index: number,
): CanonicalChatAttachment {
  const normalized = normalizeChatSubmissionAttachment(attachment, index);
  if (!normalized.ok) {
    throw new ChatAttachmentResolutionError('state_unavailable', normalized.issue.message);
  }
  return normalized.value;
}

/** Resolve V1 IDs or safely adapt N-1 path hints through owned upload state. */
export async function resolveChatSubmissionAttachments(args: {
  adapted: AdaptedWebChatSubmission;
  uploadManager?: Pick<UploadManager, 'resolveAttachments' | 'resolveLegacyAttachments'>;
  userCwd?: string;
}): Promise<ResolvedChatSubmissionAttachments> {
  const { adapted, uploadManager, userCwd } = args;
  const hasAttachments = adapted.protocol === 'canonical_v1'
    ? Boolean(adapted.canonical?.attachments.length)
    : Boolean(adapted.legacyAttachments?.length);
  if (!hasAttachments) return { materialized: [], canonical: [] };

  if (!uploadManager || !userCwd) {
    if (adapted.protocol === 'canonical_v1') {
      throw new ChatAttachmentResolutionError('state_unavailable', '附件状态服务不可用，请重试');
    }
    // Isolated test/development compatibility only. New adapters can never reach this branch.
    const materialized = adapted.legacyAttachments ?? [];
    const canonical = materialized.flatMap((attachment, index) => {
      const normalized = normalizeChatSubmissionAttachment(attachment, index);
      return normalized.ok ? [normalized.value] : [];
    });
    return { materialized, canonical };
  }

  try {
    const materialized = adapted.protocol === 'canonical_v1'
      ? await uploadManager.resolveAttachments(
          userCwd,
          adapted.canonical!.attachments.map((attachment) => attachment.attachmentId),
        )
      : await uploadManager.resolveLegacyAttachments(userCwd, adapted.legacyAttachments ?? []);
    return {
      materialized,
      canonical: materialized.map(canonicalizeResolvedAttachment),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not found|invalid attachment id|does not belong|forbidden/i.test(message)) {
      throw new ChatAttachmentResolutionError('not_found', 'attachmentId 无效或不属于当前用户');
    }
    throw new ChatAttachmentResolutionError('state_unavailable', '附件状态读取失败，请重试');
  }
}

export function canonicalAttachmentsToInbound(
  attachments: readonly CanonicalChatAttachment[],
): CanonicalAttachmentInfo[] {
  return attachments.map((attachment) => ({
    attachmentId: attachment.attachmentId,
    originalName: attachment.display.originalName,
    size: attachment.display.size ?? 0,
    mimeType: attachment.display.mimeType ?? 'application/octet-stream',
    isImage: attachment.display.isImage ?? false,
  }));
}
