import { randomUUID } from 'node:crypto';
import type { AcsOrchestratorConfig } from './config.js';
import type { OwnedOperation, OwnedOperations } from './ownedOperations.js';
import { ownershipIsTerminal, writableScope } from './ownershipState.js';
import type { SandboxManager } from './sandboxManager.js';
import type { WireToolInvocationRequest } from './protocol.js';
import type { ToolInvocationResponse, ToolInvocationStreamChunk } from 'server/runtime/handProtocol.js';
import { isRemoteUnknown, remoteUnknownResponse } from './runnerTransport.js';
import { OWNED_WAIT_BUDGETS } from './ownedWait.js';
import { remoteReceiptFromResponse } from './remoteOwnership.js';

interface OwnedInvocationInput {
  config: AcsOrchestratorConfig;
  manager: SandboxManager;
  operations: OwnedOperations;
  request: WireToolInvocationRequest;
  signal?: AbortSignal;
  execute(operation: OwnedOperation): AsyncIterable<ToolInvocationStreamChunk>;
}

/** The pump remains owned after a cancelled/disconnected HTTP consumer detaches. */
export async function* executeOwnedInvocation(input: OwnedInvocationInput): AsyncIterable<ToolInvocationStreamChunk> {
  if (input.signal?.aborted) return;
  const workspace = input.request.context.workspace;
  const ref = input.manager.ref({
    workspaceId: workspace.id!, sessionId: workspace.sessionId!, sandboxScopeId: workspace.sandboxScopeId,
    mountSubPath: workspace.mountSubPath, sharedReadOnlySubPath: workspace.sharedReadOnlySubPath,
  });
  const invocationId = input.request.context.invocationId ?? `internal-${randomUUID()}`;
  const operation = await input.operations.begin({
    kind: 'invocation', invocationId, attemptId: `${invocationId}:${randomUUID()}`, scope: writableScope(input.config, ref),
  });
  const queue: ToolInvocationStreamChunk[] = [];
  let queuedBytes = 0;
  let notify: (() => void) | undefined;
  let finished = false;
  let detached = false;
  let result: ToolInvocationResponse | undefined;
  let cancellationTimer: ReturnType<typeof setTimeout> | undefined;
  const wake = () => { const pending = notify; notify = undefined; pending?.(); };
  const endWaiter = (reason: string) => {
    if (finished || detached) return;
    detached = true;
    queue.length = 0;
    queuedBytes = 0;
    result = remoteUnknownResponse(reason);
    wake();
  };
  const cancel = () => {
    if (finished) return;
    operation.requestCancel();
    if (!cancellationTimer) {
      cancellationTimer = setTimeout(() => endWaiter('cancel_unconfirmed'), OWNED_WAIT_BUDGETS.cancellationMs);
      cancellationTimer.unref?.();
    }
  };
  input.signal?.addEventListener('abort', cancel, { once: true });
  operation.controller.signal.addEventListener('abort', cancel, { once: true });
  if (input.signal?.aborted) cancel();

  // Do not await iterator.return() on the HTTP path: a suspended generator may
  // itself be waiting on an unresponsive dependency. The pump owns that cleanup.
  const task = input.operations.context.run(operation, async () => {
    let final: ToolInvocationResponse | undefined;
    let failure: unknown;
    try {
      for await (const chunk of input.execute(operation)) {
        if (chunk.type === 'completed') { final ??= chunk.response; continue; }
        if (detached) continue;
        const bytes = Buffer.byteLength(JSON.stringify(chunk));
        if (queue.length >= 256 || queuedBytes + bytes > 8 * 1024 * 1024) {
          cancel();
          endWaiter('presentation_queue_limit');
          continue;
        }
        queue.push(chunk);
        queuedBytes += bytes;
        wake();
      }
    } catch (error) {
      failure = error;
    }
    try {
      if (isRemoteUnknown(final) || operation.record.resource === 'unknown' || (operation.dispatched && !final)) {
        await operation.unknown('remote_unconfirmed');
        final = remoteUnknownResponse('remote_unconfirmed');
      } else if (!operation.dispatched) {
        await operation.complete(operation.controller.signal.aborted ? 'cancelled' : failure ? 'failed' : 'success', {
          kind: 'never_dispatched', attemptId: operation.record.attemptId, sandboxUid: operation.record.sandboxUid,
        }, 'not_started');
      } else if (final) {
        const remote = final.metadata?.remoteExecution as { state?: unknown } | undefined;
        const background = final.metadata?.backgroundShell as { protectedUntil?: unknown } | undefined;
        const handedOff = remote?.state === 'background_owned'
          || (final.status === 'success' && typeof background?.protectedUntil === 'string'
            && Date.parse(background.protectedUntil) > Date.now());
        const resource = handedOff ? 'background_owned'
          : remote?.state === 'not_started' ? 'not_started' : 'stopped';
        await operation.complete(final.status === 'success' ? 'success' : 'failed', {
          kind: handedOff ? 'background_inventory' : 'remote_receipt', attemptId: operation.record.attemptId,
          sandboxUid: operation.record.sandboxUid,
          receipt: remoteReceiptFromResponse(final),
        }, resource);
      }
    } catch {
      operation.markUncertain('finalization_unknown');
      final = remoteUnknownResponse('finalization_unknown');
    }
    if (!detached) {
      result = final ?? { status: 'error', error: failure instanceof Error ? failure.message : 'ACS invocation ended before dispatch' };
    }
    finished = true;
    wake();
  });
  // This observer is installed immediately, not only when a caller asks for next().
  void task.catch(() => {
    operation.markUncertain('owner_pump_failed');
    if (!detached) result = remoteUnknownResponse('owner_pump_failed');
    finished = true;
    wake();
  });
  operation.waiters += 1;
  try {
    for (;;) {
      const chunk = queue.shift();
      if (chunk) {
        queuedBytes -= Buffer.byteLength(JSON.stringify(chunk));
        yield chunk;
        continue;
      }
      if (finished || detached) break;
      await new Promise<void>((resolve) => { notify = resolve; });
    }
    if (result) {
      yield { type: 'completed', response: {
        ...result, metadata: { ...result.metadata, acsOperation: {
          operationId: operation.record.operationId, attemptId: operation.record.attemptId,
          resource: operation.record.resource, finalized: ownershipIsTerminal(operation.record),
        } },
      } };
    }
  } finally {
    operation.waiters -= 1;
    input.signal?.removeEventListener('abort', cancel);
    operation.controller.signal.removeEventListener('abort', cancel);
    if (cancellationTimer) clearTimeout(cancellationTimer);
    if (!finished) operation.requestCancel();
    detached = true;
    queue.length = 0;
  }
}
