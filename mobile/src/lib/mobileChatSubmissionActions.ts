import type {
  AgentTarget, CanonicalChatSubmission, CanonicalVoiceSubmission, CanonicalWsChatMessage,
  MessageItem, MessagesController, UploadedFile,
} from '@agent/shared';
import { canonicalChatAttachmentToDisplay } from '@agent/shared';
import { buildMobileChatSubmission, toMobileChatWireMessage } from './chatSubmissionAdapter';
import type { MobileChatDeliveryController } from './mobileChatDeliveryController';
import { ownsDeliveryView, type MobileDeliveryView, type MobileSubmissionRecord } from './mobileChatDeliveryState';

export interface MobileSubmissionActions {
  delivery: MobileChatDeliveryController;
  getView: () => MobileDeliveryView;
  gate: () => string | null;
  msg: MessagesController;
  write: (message: CanonicalWsChatMessage, options?: { signal?: AbortSignal }) => Promise<boolean>;
  onRegistered: (record: MobileSubmissionRecord, bubbleIndex: number) => void;
  report: (message: string) => void;
}

async function writeAttempt(options: MobileSubmissionActions, record: MobileSubmissionRecord): Promise<boolean> {
  const { delivery } = options;
  const attempt = record.attempt;
  const canonical = record.canonical;
  if (!canonical || !delivery.isCurrent() || attempt.controller.signal.aborted) return record.fact.kind === 'accepted';
  try {
    const written = await options.write(toMobileChatWireMessage(canonical), { signal: attempt.controller.signal });
    delivery.transportFinished(record, attempt, written);
    return written || record.fact.kind === 'accepted';
  } catch {
    delivery.transportFinished(record, attempt, false);
    return record.fact.kind === 'accepted';
  }
}

/** Registration, bubble ownership and composer consumption happen synchronously BEFORE the await. */
export async function submitMobileChat(options: MobileSubmissionActions & {
  text: string;
  attachments: UploadedFile[];
  voice?: CanonicalVoiceSubmission;
  clientMsgId: string;
  target: { sessionId?: string; sandboxProfile?: string; agentTarget: AgentTarget };
  model?: string;
  consumeComposer: () => void;
}): Promise<boolean> {
  const blocked = options.gate();
  if (blocked) { options.report(blocked); return false; }
  const normalized = buildMobileChatSubmission({
    text: options.text, clientMsgId: options.clientMsgId, target: options.target,
    deliveryMode: 'queue', model: options.model, attachments: options.attachments,
    ...(options.voice ? { voice: options.voice } : {}),
  });
  if (!normalized.ok) { options.report(`附件不可发送：${normalized.issue.message}`); return false; }
  const voiceIndex = options.voice ? options.msg.messagesRef.current.findIndex(message =>
    message.type === 'user-voice' && message.attachmentId === options.voice!.attachmentId) : -1;
  if (options.voice && voiceIndex < 0) { options.report('原语音消息已不可用，请重新录制或编辑文字。'); return false; }
  const view = options.getView();
  const record = options.delivery.register(normalized.value, {
    draftId: view.draftId, ...(view.sessionId ? { sessionId: view.sessionId } : {}),
  });
  if (!record) return false;
  try {
    let index = voiceIndex;
    if (options.voice) {
      options.msg.updateMessageAt(index, message => message.type === 'user-voice' ? {
        ...message, clientMsgId: record.clientMsgId, status: 'ready',
        transcribedText: options.voice!.transcript.text, deliveryPhase: 'connecting',
      } : message);
    } else {
      index = options.msg.addMessage({
        type: 'user', content: options.text, status: 'pending', clientMsgId: record.clientMsgId,
        timestamp: Date.now(), deliveryPhase: 'connecting',
        ...(normalized.value.attachments.length ? { attachments: normalized.value.attachments.map(canonicalChatAttachmentToDisplay) } : {}),
      });
    }
    const bubble = options.msg.messagesRef.current[index];
    if (bubble?.type === 'user' || bubble?.type === 'user-voice') options.delivery.rememberBubble(record, bubble);
    options.onRegistered(record, index);
    options.consumeComposer();
  } catch {
    // Keep the registered ID/payload for read-only recovery even if a presentation callback fails.
    options.delivery.transportFinished(record, record.attempt, false);
    return false;
  }
  return writeAttempt(options, record);
}

/** Only this explicit user action may retry chat. A 404 is NOT a non-acceptance proof. */
export async function retryMobileChat(options: MobileSubmissionActions & {
  message: MessageItem;
  edit: (message: MessageItem, original?: CanonicalChatSubmission) => void;
}): Promise<void> {
  const message = options.message;
  if (message.type !== 'user' && message.type !== 'user-voice') return;
  const blocked = options.gate();
  if (blocked) { options.report(blocked); return; }
  if (!message.clientMsgId) { options.edit(message); return; }
  const view = options.getView();
  const record = options.delivery.get(message.clientMsgId) ?? options.delivery.hydrateBubble(message, {
    draftId: view.draftId, ...(view.sessionId ? { sessionId: view.sessionId } : {}),
  });
  if (!record || !ownsDeliveryView(record, view)) {
    options.report('请返回原消息所属会话后核验。'); return;
  }
  if (record.fact.kind === 'accepted') return;
  if (record.fact.kind === 'rejected' || message.deliveryIssue === 'rejected') {
    options.edit(message, record.canonical); return;
  }
  const result = await options.delivery.verify(record.clientMsgId, 'manual');
  if (!options.delivery.isCurrent() || !ownsDeliveryView(record, options.getView()) || options.gate()) return;
  if (options.delivery.get(record.clientMsgId)?.fact.kind === 'accepted' || result.kind === 'accepted' || result.kind === 'already_accepted') return;
  if (result.kind !== 'not_observed') {
    options.report('暂时无法核验是否送达，已保留原消息；请稍后再核验。'); return;
  }
  if (!record.canonical) {
    options.report('本次未查到受理记录，但原始提交已无法安全恢复。请复制内容重新编辑；不要把它当作确定未送达。');
    return;
  }
  // Duplicate safety comes from the server's durable idempotency key, never from the GET's 404.
  const attempt = options.delivery.beginAttempt(record);
  if (!attempt) return;
  const index = options.msg.messagesRef.current.findIndex(item =>
    (item.type === 'user' || item.type === 'user-voice') && item.clientMsgId === record.clientMsgId);
  options.onRegistered(record, index);
  await writeAttempt(options, record);
}
