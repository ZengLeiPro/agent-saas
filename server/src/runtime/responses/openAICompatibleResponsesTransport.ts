import { createHash } from 'node:crypto';

import type {
  ModelChatMessage,
  ModelToolDefinition,
  RuntimeConnection,
} from '../types.js';
import type {
  ResponsesTransport,
  ResponsesTransportExecuteInput,
  ResponsesTransportExecuteResult,
} from './responsesTransport.js';

function responsesUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (trimmed.endsWith('/responses')) return trimmed;
  return `${trimmed}/responses`;
}

function responsesByIdUrl(baseUrl: string, responseId: string): string {
  return `${responsesUrl(baseUrl)}/${encodeURIComponent(responseId)}`;
}

/**
 * Existing API-key Responses behavior behind the new transport seam.
 * This class intentionally preserves the old wire shape so introducing the seam
 * does not change Ark/OpenAI-compatible production traffic.
 */
export class OpenAICompatibleResponsesTransport implements ResponsesTransport {
  readonly id = 'openai_compatible' as const;
  readonly capabilities = {
    responseState: 'stored',
    terminalOutput: 'canonical',
    usageLookup: true,
    responseDelete: true,
    encryptedReasoning: false,
    omitToolConfigurationWhenEmpty: false,
    parallelToolCalls: false,
    maxOutputTokens: true,
  } as const;

  constructor(private readonly connection: Required<RuntimeConnection>) {}

  computePromptCacheKey(input: {
    model: string;
    messages: ModelChatMessage[];
    tools: ModelToolDefinition[];
  }): string {
    const systemContent = input.messages.find((message) => message.role === 'system')?.content ?? '';
    const toolSignature = input.tools
      .map((tool) => `${tool.mcpServer?.namespace ?? '-'}:${tool.name}:${tool.deferLoading === true ? 'deferred' : 'eager'}`)
      .sort()
      .join(',');
    return createHash('sha256')
      .update(`${input.model}\n${systemContent}\n${toolSignature}`)
      .digest('hex')
      .slice(0, 32);
  }

  async execute(input: ResponsesTransportExecuteInput): Promise<ResponsesTransportExecuteResult> {
    return {
      response: await fetch(responsesUrl(this.connection.baseUrl), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.connection.apiKey}`,
          'content-type': 'application/json',
          'x-client-request-id': input.clientRequestId,
        },
        body: input.serializedBody,
        signal: input.signal,
      }),
    };
  }

  getResponse(responseId: string, signal?: AbortSignal): Promise<Response> {
    return fetch(responsesByIdUrl(this.connection.baseUrl, responseId), {
      method: 'GET',
      headers: { authorization: `Bearer ${this.connection.apiKey}` },
      ...(signal ? { signal } : {}),
    });
  }

  deleteResponse(responseId: string, signal?: AbortSignal): Promise<Response> {
    return fetch(responsesByIdUrl(this.connection.baseUrl, responseId), {
      method: 'DELETE',
      headers: { authorization: `Bearer ${this.connection.apiKey}` },
      ...(signal ? { signal } : {}),
    });
  }
}
