import type { GuardrailModelConfig } from '../agent/guardrail.js';
import type { GuardrailAppConfig } from './config.js';
import type { ModelsConfig } from '../types/index.js';
import { resolveModelRef } from './models.js';

interface GuardrailConfigLogger {
  info(message: string): void;
  warn(message: string): void;
}

export function resolveGuardrailModelConfigs(input: {
  models?: ModelsConfig;
  guardrail?: GuardrailAppConfig;
  logger?: GuardrailConfigLogger;
}): GuardrailModelConfig[] {
  const { models, guardrail, logger } = input;
  if (!guardrail?.model || !models) return [];

  const configs: GuardrailModelConfig[] = [];
  for (const ref of [guardrail.model, ...(guardrail.fallbackModels ?? [])]) {
    const resolved = resolveModelRef(models, ref);
    if (!resolved) {
      logger?.warn(`Guardrail: model ref "${ref}" not found, skipped`);
      continue;
    }
    configs.push({ model: resolved.model, connection: resolved.connection });
    logger?.info(`Guardrail: model "${resolved.model}" from "${ref}"`);
    const refModelId = ref.split('/').pop() ?? '';
    if (refModelId && resolved.model !== refModelId) {
      logger?.warn(
        `Guardrail: ref "${ref}" silently fell back to default ` +
          `(resolved="${resolved.model}"); check models.groups for the correct groupId.`,
      );
    }
  }
  if (configs.length === 0) logger?.warn('Guardrail: no model resolved from config.guardrail, module inactive');
  return configs;
}
