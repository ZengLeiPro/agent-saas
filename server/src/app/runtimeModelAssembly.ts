import type { GuardrailModelConfig } from '../agent/guardrail.js';
import type { TitleGeneratorConfig } from '../agent/titleGenerator.js';
import type { SecretVault } from '../security/secretVault.js';
import type { AppConfig } from './config.js';
import { resolveGuardrailModelConfigs } from './guardrailModelConfigs.js';
import { assertAuxiliaryModelRefsResolvable } from './modelsHotUpdate.js';
import { resolveModelsConfig } from './runtimeGovernanceCredentials.js';
import { resolveTitleGeneratorConfigs } from './titleGeneratorConfigs.js';

interface RuntimeModelAssemblyLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface RuntimeModelAssembly {
  resolvedModels: AppConfig['models'];
  titleGeneratorConfigs: TitleGeneratorConfig[];
  guardrailModelConfigs: GuardrailModelConfig[];
}

/**
 * 主模型与公共辅助模型必须从同一份 SecretVault 已解析快照装配。
 *
 * 持久化配置只保存 apiKeyRef；若标题/智能分组/门禁链提前从原始配置构造，
 * 非 Codex 模型会因连接中缺少 apiKey 被跳过，而主会话仍可正常使用已解析模型。
 */
export async function assembleRuntimeModels(input: {
  config: AppConfig;
  secretVault: SecretVault;
  defaultTitleModel?: string;
  logger?: RuntimeModelAssemblyLogger;
}): Promise<RuntimeModelAssembly> {
  if (input.config.models) {
    assertAuxiliaryModelRefsResolvable(input.config, input.config.models);
  }
  const resolvedModels = await resolveModelsConfig(input.config.models, input.secretVault);
  return {
    resolvedModels,
    titleGeneratorConfigs: resolveTitleGeneratorConfigs({
      models: resolvedModels,
      titleGenerator: input.config.titleGenerator,
      defaultModel: input.defaultTitleModel,
      logger: input.logger,
    }),
    guardrailModelConfigs: resolveGuardrailModelConfigs({
      models: resolvedModels,
      guardrail: input.config.guardrail,
      logger: input.logger,
    }),
  };
}
