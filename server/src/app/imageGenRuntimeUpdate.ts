import type { ResolvedImageGenToolsConfig } from '../agent/imageGenToolProvider.js';
import { configureImageGenPricing } from '../data/usage/imageGenPricing.js';
import type { SecretVault } from '../security/secretVault.js';
import { resolveImageGenToolsConfig } from './runtimeGovernanceCredentials.js';
import type { AppConfig } from './config.js';

export type ImageGenRuntimeUpdateCommit = () => void;

/** Secret 解析在 prepare 完成；commit 仅交换执行快照与定价注册表。 */
export function createImageGenRuntimeUpdatePreparer(options: {
  target: { imageGenTools?: ResolvedImageGenToolsConfig };
  secretVault: SecretVault;
}) {
  return async function prepareImageGenRuntimeUpdate(
    next: AppConfig['imageGenTools'],
  ): Promise<ImageGenRuntimeUpdateCommit> {
    const resolved = await resolveImageGenToolsConfig(next, options.secretVault);
    return () => {
      if (resolved) options.target.imageGenTools = resolved;
      else delete options.target.imageGenTools;
      configureImageGenPricing(next?.pricing);
    };
  };
}
