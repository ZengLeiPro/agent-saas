import type { MessageItem } from '../types/message';
import type { WsEvent, WsSyncPendingInteractionSnapshot } from '../types/ws';
import { interactionKey } from './interactionProtocol';
import { formatPermissionInput, resolvePlanModeDisplay } from './wsToolDisplay';

type InteractionMessage = Extract<MessageItem, { type: 'permission_request' | 'ask_user' }>;
type InteractionRequest =
  Extract<WsEvent, { type: 'permission_request' | 'ask_user' }> | WsSyncPendingInteractionSnapshot;

const isInteractionMessage = (message: MessageItem): message is InteractionMessage =>
  message.type === 'permission_request' || message.type === 'ask_user';

const isTerminalInteractionMessage = (message: InteractionMessage): boolean =>
  message.status !== 'pending';

function requestToMessage(
  request: InteractionRequest,
  previous?: InteractionMessage,
): InteractionMessage | null {
  const previousVersion = previous?.interactionVersion;
  const version =
    Number.isSafeInteger(request.version) &&
    request.version! > 0 &&
    (!Number.isSafeInteger(previousVersion) || request.version! >= previousVersion!)
      ? request.version
      : previousVersion;
  const previousOrder = previous?.interactionOrder;
  const order =
    Number.isSafeInteger(request.order) &&
    request.order! > 0 &&
    (!Number.isSafeInteger(previousOrder) || request.order! >= previousOrder!)
      ? request.order
      : previousOrder;
  if (request.type === 'ask_user' && request.questions) {
    return {
      id: previous?.id ?? `pending-${request.interactionId}`,
      type: 'ask_user',
      interactionId: request.interactionId,
      ...(version !== undefined ? { interactionVersion: version } : {}),
      ...(order !== undefined ? { interactionOrder: order } : {}),
      questions: request.questions,
      status: 'pending',
    };
  }
  if ((request.type === 'permission_request' || request.type === 'approval') && request.toolName) {
    const { name, description } = resolvePlanModeDisplay(
      request.toolName,
      formatPermissionInput(request.toolInput),
      request.planContent,
      request.displayName,
    );
    return {
      id: previous?.id ?? `pending-${request.interactionId}`,
      type: 'permission_request',
      interactionId: request.interactionId,
      ...(version !== undefined ? { interactionVersion: version } : {}),
      ...(order !== undefined ? { interactionOrder: order } : {}),
      toolName: name,
      toolInput: description,
      status: 'pending',
    };
  }
  return null;
}

function withPendingRuntimeStatus(messages: MessageItem[]): MessageItem[] {
  const pending = messages
    .filter(
      (message): message is InteractionMessage =>
        isInteractionMessage(message) && message.status === 'pending',
    )
    .sort(
      (left, right) =>
        (left.interactionOrder ?? Number.MAX_SAFE_INTEGER) -
        (right.interactionOrder ?? Number.MAX_SAFE_INTEGER),
    );
  const waiting =
    pending[0]?.type === 'permission_request'
      ? 'waiting_approval'
      : pending[0]?.type === 'ask_user'
        ? 'waiting_user'
        : null;
  let runtimeIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].type === 'runtime_status') {
      runtimeIndex = index;
      break;
    }
  }
  if (!waiting) {
    return messages.filter(
      (message) =>
        message.type !== 'runtime_status' ||
        (message.status !== 'waiting_user' && message.status !== 'waiting_approval'),
    );
  }
  const patch = {
    status: waiting,
    content: waiting === 'waiting_user' ? '待补充' : '待处理',
    streaming: true,
  } as const;
  if (runtimeIndex < 0)
    return [...messages, { id: `pending-runtime-${waiting}`, type: 'runtime_status', ...patch }];
  const next = [...messages];
  next[runtimeIndex] = { ...next[runtimeIndex], ...patch } as MessageItem;
  return next;
}

function terminalInteractionIds(messages: readonly MessageItem[]): Set<string> {
  return new Set(
    messages
      .filter(
        (message): message is InteractionMessage =>
          isInteractionMessage(message) && isTerminalInteractionMessage(message),
      )
      .map((message) => message.interactionId),
  );
}

export function rememberResolvedInteraction(
  keys: Set<string>,
  sessionId: string,
  interactionId: string,
): void {
  keys.add(interactionKey(sessionId, interactionId));
  if (keys.size > 1_000) keys.delete(keys.values().next().value!);
}

export function isRememberedResolvedInteraction(
  keys: ReadonlySet<string> | undefined,
  sessionId: string,
  interactionId: string,
): boolean {
  return Boolean(keys?.has(interactionKey(sessionId, interactionId)));
}

/** Merge one live request without duplicating an existing card or reviving a terminal receipt. */
export function projectInteractionRequest(
  messages: readonly MessageItem[],
  request: InteractionRequest,
): MessageItem[] {
  const next = [...messages];
  const matches = next.flatMap((message, index) =>
    isInteractionMessage(message) && message.interactionId === request.interactionId ? [index] : [],
  );
  if (matches.some((index) => isTerminalInteractionMessage(next[index] as InteractionMessage)))
    return withPendingRuntimeStatus(next);
  const first = matches[0];
  const projected = requestToMessage(
    request,
    first === undefined ? undefined : (next[first] as InteractionMessage),
  );
  if (!projected) return withPendingRuntimeStatus(next);
  if (first === undefined) {
    if (!next.some((message) => message.type === 'runtime_status')) {
      const status = projected.type === 'permission_request' ? 'waiting_approval' : 'waiting_user';
      next.push({
        id: `pending-runtime-${status}`,
        type: 'runtime_status',
        status,
        content: status === 'waiting_user' ? '待补充' : '待处理',
        streaming: true,
      });
    }
    next.push(projected);
  } else next[first] = projected;
  for (let index = matches.length - 1; index >= 1; index -= 1) next.splice(matches[index], 1);
  return withPendingRuntimeStatus(next);
}

/** Apply an authoritative replacement snapshot. Terminal receipts/tombstones always win over stale pending data. */
export function projectPendingInteractionSnapshot(
  messages: readonly MessageItem[],
  requests: readonly WsSyncPendingInteractionSnapshot[],
  sessionId: string,
  resolvedKeys?: ReadonlySet<string>,
  preservePendingIds?: ReadonlySet<string>,
): MessageItem[] {
  const terminalIds = terminalInteractionIds(messages);
  const seen = new Set<string>();
  const effective = requests.filter(
    (request) =>
      !request.receipt &&
      !seen.has(request.interactionId) &&
      seen.add(request.interactionId) &&
      !terminalIds.has(request.interactionId) &&
      !isRememberedResolvedInteraction(resolvedKeys, sessionId, request.interactionId),
  );
  const authoritativeIds = new Set(effective.map((request) => request.interactionId));
  let next = messages.filter(
    (message) =>
      !isInteractionMessage(message) ||
      message.status !== 'pending' ||
      authoritativeIds.has(message.interactionId) ||
      preservePendingIds?.has(message.interactionId),
  );
  for (const request of effective) next = projectInteractionRequest(next, request);
  return withPendingRuntimeStatus(next);
}

/** Apply one canonical outcome once and collapse legacy duplicate cards. */
export function projectInteractionResolution(
  messages: readonly MessageItem[],
  interactionId: string,
  response?: Record<string, unknown>,
): MessageItem[] {
  const matches = messages.flatMap((message, index) =>
    isInteractionMessage(message) && message.interactionId === interactionId ? [index] : [],
  );
  if (!matches.length) return withPendingRuntimeStatus([...messages]);
  const keep =
    matches.find((index) => isTerminalInteractionMessage(messages[index] as InteractionMessage)) ??
    matches[0];
  const current = messages[keep] as InteractionMessage;
  let replacement: InteractionMessage | null = current;
  if (current.status === 'pending') {
    if (current.type === 'permission_request' && typeof response?.allow === 'boolean') {
      replacement = { ...current, status: response.allow ? 'allowed' : 'denied' };
    } else if (
      current.type === 'ask_user' &&
      response?.answers &&
      typeof response.answers === 'object' &&
      !Array.isArray(response.answers)
    ) {
      replacement = {
        ...current,
        status: 'answered',
        answers: response.answers as Extract<InteractionMessage, { type: 'ask_user' }>['answers'],
      };
    } else {
      replacement = null;
    }
  }
  const next = messages.flatMap((message, index) =>
    isInteractionMessage(message) && message.interactionId === interactionId
      ? index === keep && replacement
        ? [replacement]
        : []
      : [message],
  );
  return withPendingRuntimeStatus(next);
}
