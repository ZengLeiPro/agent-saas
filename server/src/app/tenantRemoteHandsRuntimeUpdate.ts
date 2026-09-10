import type { SecretVault } from '../security/secretVault.js';
import {
  createTenantRemoteHandAuthTokenResolver,
  type TenantRemoteHandAuthTokenResolver,
} from '../runtime/tenantRemoteHandResolver.js';
import type { TenantRemoteHandDispatchConfig } from '../runtime/rawRuntimeRunDispatch.js';
import type { AppConfig } from './config.js';

export type TenantRemoteHandsRuntimeUpdateCommit = () => void;

export interface TenantRemoteHandsRuntimeState {
  getHands(): TenantRemoteHandDispatchConfig[] | undefined;
  prepare(next: AppConfig['tenantRemoteHands']): Promise<TenantRemoteHandsRuntimeUpdateCommit>;
  resolver: TenantRemoteHandAuthTokenResolver;
}

/**
 * 新 dispatch 只读取本 registry 的不可变快照。prepare 先解析全部候选凭据，
 * commit 才交换快照；已开始的任务继续持有它自己的 hand/lease。
 */
export function createTenantRemoteHandsRuntimeState(options: {
  initial: AppConfig['tenantRemoteHands'];
  vault: SecretVault;
  logger?: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
}): TenantRemoteHandsRuntimeState {
  let hands = options.initial?.hands ? structuredClone(options.initial.hands) : undefined;
  const getHands = () => hands;
  const resolver = createTenantRemoteHandAuthTokenResolver({
    tenantRemoteHands: getHands,
    vault: options.vault,
    ...(options.logger ? { logger: options.logger } : {}),
  });
  return {
    getHands,
    resolver,
    async prepare(next) {
      const candidate = next?.hands ? structuredClone(next.hands) : undefined;
      const validator = createTenantRemoteHandAuthTokenResolver({
        tenantRemoteHands: candidate,
        vault: options.vault,
      });
      await Promise.all((candidate ?? []).map((hand) => validator.resolveForRegister(hand)));
      return () => {
        hands = candidate;
      };
    },
  };
}
