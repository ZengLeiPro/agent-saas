import type { TitleGeneratorConfig } from '../agent/titleGenerator.js';
import type { TitleGeneratorAppConfig } from './config.js';
import type { ModelsConfig } from '../types/index.js';
import { resolveModelRefStrict } from './models.js';

interface TitleConfigLogger {
  info(message: string): void;
  warn(message: string): void;
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
      connection: resolved.connection,
      ...(protocol ? { protocol } : {}),
      ...(responsesTransport ? { responsesTransport } : {}),
    });
    logger?.info(
      index === 0
        ? `Title generator: using model "${resolved.model}" from "${ref}"`
        : `Title generator: fallback "${resolved.model}" from "${ref}"`,
    );
  }

  return configs;
}
