import type { ChannelContext, UploadedFileInfo } from '../../types/index.js';
import { resolveUserCwd } from '../../workspace/resolver.js';
import type { UploadManager } from '../../uploads/manager.js';
import { chatLogger } from '../../utils/logger.js';

export async function bindChatAttachments(
  uploadManager: Pick<UploadManager, 'markReferenced'>,
  agentCwd: string,
  user: ChannelContext['user'],
  attachments: readonly UploadedFileInfo[],
  sessionId: string,
  clientMessageId: string,
): Promise<boolean> {
  try {
    await uploadManager.markReferenced(resolveUserCwd(agentCwd, user), attachments, {
      sessionId,
      clientMessageId,
    });
    return true;
  } catch (error) {
    chatLogger.error(`[attachments] failed to bind new session: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
