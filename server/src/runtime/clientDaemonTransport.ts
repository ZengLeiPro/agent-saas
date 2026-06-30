import type { ToolDescriptor } from '../agent/toolRuntime.js';
import type { ExecutionTransport } from './executionTransport.js';
import type { ToolInvocationRequest, ToolInvocationResponse, ToolInvocationStream } from './handProtocol.js';
import type { HandCapability } from './handStore.js';

export interface ClientDaemonConnection {
  handId: string;
  capabilities: HandCapability[];
  invoke(request: ToolInvocationRequest): Promise<ToolInvocationResponse>;
  invokeStream?(request: ToolInvocationRequest): ToolInvocationStream;
  cancel?(invocationId: string): Promise<void>;
  lastSeenAt?: string;
  close?(): Promise<void>;
}

export class ClientDaemonTransport implements ExecutionTransport {
  private readonly connections = new Map<string, ClientDaemonConnection>();

  register(connection: ClientDaemonConnection): void {
    this.connections.set(connection.handId, connection);
  }

  unregister(handId: string): void {
    this.connections.delete(handId);
  }

  has(handId: string): boolean {
    return this.connections.has(handId);
  }

  async invoke(request: ToolInvocationRequest): Promise<ToolInvocationResponse> {
    const handId = request.context.handId;
    if (!handId) {
      return { status: 'error', error: 'client daemon invocation requires context.handId' };
    }
    const connection = this.connections.get(handId);
    if (!connection) {
      return { status: 'error', error: `client daemon hand not connected: ${handId}` };
    }
    return connection.invoke(request);
  }

  invokeStream(request: ToolInvocationRequest): ToolInvocationStream {
    return this.invokeStreamInternal(request);
  }

  private async *invokeStreamInternal(request: ToolInvocationRequest): ToolInvocationStream {
    const handId = request.context.handId;
    if (!handId) {
      yield { type: 'completed', response: { status: 'error', error: 'client daemon stream requires context.handId' } };
      return;
    }
    const connection = this.connections.get(handId);
    if (!connection) {
      yield { type: 'completed', response: { status: 'error', error: `client daemon hand not connected: ${handId}` } };
      return;
    }
    if (!connection.invokeStream) {
      yield { type: 'completed', response: await connection.invoke(request) };
      return;
    }
    let sawCompleted = false;
    const onAbort = () => {
      const invocationId = request.context.invocationId;
      if (invocationId) void connection.cancel?.(invocationId);
    };
    request.context.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      for await (const chunk of connection.invokeStream(request)) {
        if (chunk.type === 'completed') sawCompleted = true;
        yield chunk;
      }
      if (!sawCompleted) {
        yield { type: 'completed', response: { status: 'error', error: 'client daemon stream ended without completed chunk' } };
      }
    } catch (err) {
      yield {
        type: 'completed',
        response: { status: 'error', error: `client daemon stream failed: ${err instanceof Error ? err.message : String(err)}` },
      };
    } finally {
      request.context.signal?.removeEventListener('abort', onAbort);
    }
  }

  async cancel(handId: string, invocationId: string): Promise<void> {
    await this.connections.get(handId)?.cancel?.(invocationId);
  }

  listInternalTools(): ToolDescriptor[] {
    const byName = new Map<string, ToolDescriptor>();
    for (const connection of this.connections.values()) {
      for (const capability of connection.capabilities) {
        for (const tool of capability.tools) byName.set(tool.name, tool);
      }
    }
    return [...byName.values()];
  }
}
