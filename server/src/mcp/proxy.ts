import { parseMcpToolKey, type McpClientManager, type McpToolDescriptor } from './clientManager.js';
import { CapabilityTokenService } from '../security/capabilityToken.js';
import type { SecretVault } from '../security/secretVault.js';

export interface McpProxyInvokeInput {
  username: string | undefined;
  userId?: string;
  sessionId?: string;
  runId?: string;
  toolKey: string;
  input: Record<string, unknown>;
}

export interface McpProxyOptions {
  manager: McpClientManager;
  capabilityTokens?: CapabilityTokenService;
  vault?: SecretVault;
  warmupWithCredential?: (input: {
    username: string;
    userId: string;
    sessionId: string;
    runId: string;
  }) => Promise<McpToolDescriptor[]>;
  executeWithCredential?: (input: {
    username: string;
    userId: string;
    sessionId: string;
    runId?: string;
    serverName: string;
    toolName: string;
    toolKey: string;
    input: Record<string, unknown>;
  }) => Promise<string>;
  logger?: { info?: (message: string, meta?: Record<string, unknown>) => void };
}

/**
 * Capability-scoped MCP invocation boundary. The agent/tool provider talks to
 * this proxy instead of calling McpClientManager directly; future OAuth-backed
 * MCP servers can resolve SecretRef values here without exposing credentials to
 * the sandbox or to model-generated code.
 */
export class McpProxy {
  private readonly capabilityTokens: CapabilityTokenService;

  constructor(private readonly options: McpProxyOptions) {
    this.capabilityTokens = options.capabilityTokens ?? new CapabilityTokenService();
  }

  async warmup(input: {
    username?: string;
    userId?: string;
    sessionId?: string;
    runId?: string;
  }): Promise<McpToolDescriptor[]> {
    if (!input.username || !input.userId || !input.sessionId || !input.runId
      || !this.options.warmupWithCredential) return [];
    return this.options.warmupWithCredential({
      username: input.username,
      userId: input.userId,
      sessionId: input.sessionId,
      runId: input.runId,
    });
  }

  async invoke(input: McpProxyInvokeInput): Promise<string> {
    if (!input.username) throw new Error(`MCP proxy invoke: missing username for ${input.toolKey}`);
    const parsed = parseMcpToolKey(input.toolKey);
    if (!parsed) throw new Error(`MCP proxy invoke: invalid tool key ${input.toolKey}`);
    const sessionId = input.sessionId ?? 'unknown-session';
    const userId = input.userId ?? input.username;
    const capability = this.capabilityTokens.issue({
      sessionId,
      userId,
      serverName: parsed.serverName,
      toolName: parsed.toolName,
      scopes: [
        'mcp:invoke',
        `mcp:${parsed.serverName}:invoke`,
        `mcp:${parsed.serverName}:${parsed.toolName}:invoke`,
      ],
    });
    this.capabilityTokens.verify(capability.token, ['mcp:invoke']);
    this.options.logger?.info?.('MCP proxy capability issued', {
      sessionId,
      userId,
      serverName: parsed.serverName,
      toolName: parsed.toolName,
      expiresAt: capability.expiresAt,
    });
    if (!this.options.executeWithCredential) throw new Error('CREDENTIAL_BROKER_UNAVAILABLE');
    return this.options.executeWithCredential({
      username: input.username,
      userId,
      sessionId,
      ...(input.runId ? { runId: input.runId } : {}),
      serverName: parsed.serverName,
      toolName: parsed.toolName,
      toolKey: input.toolKey,
      input: input.input,
    });
  }
}
