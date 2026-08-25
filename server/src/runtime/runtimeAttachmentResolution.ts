import type { InboundMessage } from '../types/index.js';
import { resolveInboundAttachments } from './imageAttachments.js';
import type { RawRuntimeRunDispatchConfig } from './rawRuntimeRunDispatchTypes.js';

export function resolveRuntimeInboundAttachments(
  config: RawRuntimeRunDispatchConfig,
  cwd: string,
  sessionId: string,
  message: Pick<InboundMessage, 'attachments' | 'channel'>,
) {
  return resolveInboundAttachments(message.attachments, {
    cwd,
    channel: message.channel,
    ...(config.uploadManager ? {
      resolveWebAttachments: (attachmentIds) => config.uploadManager!.resolveAttachments(
        cwd,
        attachmentIds,
        { sessionId },
      ),
    } : {}),
  });
}
