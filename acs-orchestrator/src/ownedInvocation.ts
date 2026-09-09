import { randomUUID } from 'node:crypto';
import type { AcsOrchestratorConfig } from './config.js';
import type { OwnedOperation, OwnedOperations } from './ownedOperations.js';
import { ownershipIsTerminal, writableScope } from './ownershipState.js';
import type { SandboxManager } from './sandboxManager.js';
import type { WireToolInvocationRequest } from './protocol.js';
import type { ToolInvocationResponse, ToolInvocationStreamChunk } from 'server/runtime/handProtocol.js';
import { isRemoteUnknown, remoteUnknownResponse } from './runnerTransport.js';

interface OwnedInvocationInput {
  config: AcsOrchestratorConfig;
  manager: SandboxManager;
  operations: OwnedOperations;
  request: WireToolInvocationRequest;
  signal?: AbortSignal;
  execute(operation: OwnedOperation): AsyncIterable<ToolInvocationStreamChunk>;
}

/** The actual executor remains the task owner; this wrapper independently settles its caller. */
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
  let final: ToolInvocationResponse | undefined;
  let failure: unknown;
  const onAbort = () => { if (!final) operation.requestCancel(); };
  input.signal?.addEventListener('abort', onAbort, { once: true });
  if (input.signal?.aborted) onAbort();
  const iterator = input.execute(operation)[Symbol.asyncIterator]();
  operation.waiters += 1;
  try {
    for (;;) {
      // Creating an async generator inside ALS is insufficient: each next/return
      // must execute within the owner's context so transport failures retain it.
      const next = await input.operations.context.run(operation, () => iterator.next());
      if (next.done) break;
      if (next.value.type === 'completed') final ??= next.value.response;
      else yield next.value;
    }
  } catch (error) {
    failure = error;
  } finally {
    operation.waiters -= 1;
    input.signal?.removeEventListener('abort', onAbort);
    if (iterator.return) {
      try { await input.operations.context.run(operation, () => iterator.return!()); }
      catch (error) { failure ??= error; }
    }
    try {
      if (isRemoteUnknown(final) || operation.record.resource === 'unknown'
        || (operation.dispatched && !final)) {
        await operation.unknown(operation.controller.signal.aborted ? 'cancel_unconfirmed' : 'remote_unconfirmed');
        final = { ...(final ?? remoteUnknownResponse('remote_unconfirmed')),
          metadata: { ...final?.metadata, remoteExecution: { state: 'unknown', attemptId: operation.record.attemptId } } };
      } else if (!operation.dispatched) {
        await operation.complete(operation.controller.signal.aborted ? 'cancelled' : failure ? 'failed' : 'success', {
          kind: 'never_dispatched', attemptId: operation.record.attemptId, sandboxUid: operation.record.sandboxUid,
        }, 'not_started');
      } else if (final) {
        const background = final.metadata?.backgroundShell as { protectedUntil?: unknown } | undefined;
        const handedOff = final.status === 'success' && typeof background?.protectedUntil === 'string'
          && Date.parse(background.protectedUntil) > Date.now();
        // This is the legacy daemon's exact-attempt final contract, not a claim
        // that local kubectl exit or an HTTP cancel confirmed remote termination.
        // Supervised descendant receipts remain a separately gated protocol upgrade.
        await operation.complete(final.status === 'success' ? 'success' : 'failed', {
          kind: handedOff ? 'background_inventory' : 'remote_receipt', attemptId: operation.record.attemptId,
          sandboxUid: operation.record.sandboxUid,
        }, handedOff ? 'background_owned' : 'stopped');
      }
    } catch {
      operation.markUncertain('finalization_unknown');
      final = remoteUnknownResponse('finalization_unknown');
    }
  }
  if (failure && !final) throw failure;
  if (final) {
    yield { type: 'completed', response: {
      ...final, metadata: { ...final.metadata, acsOperation: {
        operationId: operation.record.operationId, attemptId: operation.record.attemptId,
        resource: operation.record.resource, finalized: ownershipIsTerminal(operation.record),
      } },
    } };
  }
}
