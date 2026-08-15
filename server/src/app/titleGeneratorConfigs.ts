import type { TitleGeneratorConfig } from '../agent/titleGenerator.js';
import type { TitleGeneratorAppConfig } from './config.js';
import type { ModelsConfig } from '../types/index.js';
import type { CodexCredentialManager } from '../runtime/responses/codexCredentialManager.js';
import { createModelAdapterForProtocol, type ModelAdapterFactory } from '../runtime/rawRuntimeRunDispatch.js';
import { resolveModelRefStrict } from './models.js';

interface TitleConfigLogger {
  info(message: string): void;
  warn(message: string): void;
}

/** 标题调用复用 Codex OAuth，但不接入主会话 WebSocket pool。 */
export function createTitleModelAdapterFactory(
  codexCredentialManager: CodexCredentialManager,
  codexFetch: typeof fetch,
): ModelAdapterFactory {
  return (connection, providerOptions) => createModelAdapterForProtocol(
    connection,
    providerOptions,
    { codexCredentialManager, codexFetch },
  );
}

export function resolveTitleGeneratorConfigs(input: {
  models?: ModelsConfig;
  titleGenerator?: TitleGeneratorAppConfig;
  defaultModel?: string;
  logger?: TitleConfigLogger;
}): TitleGeneratorConfig[] {
  const { models, titleGenerator, defaultModel, logger } = input;
  if (!titleGenerator?.model || !models) {
    return defaultModel ? [{ model: defaultModel }] : [];
  }

  const configs: TitleGeneratorConfig[] = [];
  const seen = new Set<string>();
  const refs = [titleGenerator.model, ...(titleGenerator.fallbackModels ?? [])];

  for (const [index, ref] of refs.entries()) {
    const resolved = resolveModelRefStrict(models, ref);
    if (!resolved) {
      logger?.warn(`Title generator: model ref "${ref}" not found, skipped`);
      continue;
    }

    const protocol = resolved.providerOptions?.protocol;
    const responsesTransport = resolved.providerOptions?.responsesTransport;
    const identity = [resolved.connection?.baseUrl ?? '', resolved.model, protocol ?? '', responsesTransport ?? ''].join('\0');
    if (seen.has(identity)) {
      logger?.warn(`Title generator: duplicate model ref "${ref}" resolved to "${resolved.model}", skipped`);
      continue;
    }
    seen.add(identity);
    configs.push({
      model: resolved.model,
      modelRef: ref,
      connection: resolved.connection,
      ...(protocol ? { protocol } : {}),
      ...(responsesTransport ? { responsesTransport } : {}),
      ...(resolved.providerOptions ? { providerOptions: resolved.providerOptions } : {}),
    });
    logger?.info(
      index === 0
        ? `Title generator: using model "${resolved.model}" from "${ref}"`
        : `Title generator: fallback "${resolved.model}" from "${ref}"`,
    );
  }

  return configs;
}
