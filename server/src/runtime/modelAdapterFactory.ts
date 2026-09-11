import type { ModelProviderOptions } from '../types/index.js';
import type { ModelAdapter } from './types.js';
import type { ModelAdapterFactoryDependencies } from './rawRuntimeRunDispatchTypes.js';
import { ResponsesApiAdapter } from './responsesApiAdapter.js';
import { ChatCompletionsModelAdapter } from './chatCompletionsAdapter.js';
import { CodexSubscriptionResponsesTransport } from './responses/codexSubscriptionResponsesTransport.js';
import { GrokSubscriptionResponsesTransport } from './responses/grokSubscriptionResponsesTransport.js';
import { GROK_SUBSCRIPTION_BASE_URL } from './responses/grokProtocol.js';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export function createModelAdapterForProtocol(
  connection: { apiKey?: string; baseUrl?: string },
  modelProviderOptions: ModelProviderOptions | undefined,
  dependencies: ModelAdapterFactoryDependencies = {},
): ModelAdapter {
  if ((modelProviderOptions?.responsesTransport === 'grok_subscription' || modelProviderOptions?.responsesTransport === 'codex_subscription') && modelProviderOptions.protocol !== 'responses') {
    throw new Error('Subscription transport requires Responses protocol; API Key fallback is forbidden');
  }
  if (modelProviderOptions?.protocol === 'responses') {
    if (modelProviderOptions.responsesTransport === 'grok_subscription') {
      if (!dependencies.grokCredentialManager)
        throw new Error('Grok subscription transport 缺少 GrokCredentialManager');
      return new ResponsesApiAdapter(
        { apiKey: '', baseUrl: GROK_SUBSCRIPTION_BASE_URL },
        { ...modelProviderOptions, disableResponseChaining: true, disablePromptCacheKey: true },
        new GrokSubscriptionResponsesTransport(
          dependencies.grokCredentialManager,
          dependencies.grokFetch,
          dependencies.grokModelCatalog,
        ),
      );
    }

    if (modelProviderOptions.responsesTransport === 'codex_subscription') {
      if (!dependencies.codexCredentialManager) {
        throw new Error('Codex subscription transport 缺少 CodexCredentialManager');
      }
      return new ResponsesApiAdapter(
        {
          apiKey: connection.apiKey ?? '',
          baseUrl: connection.baseUrl ?? 'https://chatgpt.com/backend-api/codex',
        },
        {
          ...modelProviderOptions,
          disableResponseChaining: true,
          disablePromptCacheKey: false,
        },
        new CodexSubscriptionResponsesTransport(
          dependencies.codexCredentialManager,
          dependencies.codexFetch,
          dependencies.codexWebSocketPool,
        ),
      );
    }
    if (!connection.apiKey) throw new Error('Responses model 缺少 API Key');
    return new ResponsesApiAdapter(
      {
        apiKey: connection.apiKey,
        baseUrl: connection.baseUrl ?? DEFAULT_BASE_URL,
      },
      modelProviderOptions,
    );
  }
  if (!connection.apiKey) throw new Error('Chat Completions model 缺少 API Key');
  return new ChatCompletionsModelAdapter(
    {
      apiKey: connection.apiKey,
      baseUrl: connection.baseUrl ?? DEFAULT_BASE_URL,
    },
    modelProviderOptions ?? {},
  );
}
