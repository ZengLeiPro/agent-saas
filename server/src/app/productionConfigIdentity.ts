import type { ConfigIdentitySummary } from '@agent/shared/schemas/configIdentity';
import { existsSync } from 'node:fs';
import {
  assertPublishedDisk,
  authorityDirectory,
  publishedExpected,
  readPublication,
} from '../../../scripts/release/config-publication.mjs';
import {
  computeObservedConfigIdentity,
  evaluateConfigIdentityStatus,
  type ExpectedConfigIdentity,
} from '../release/configIdentity.js';
import type { AppConfig } from './config.js';
import type { SecretVault } from '../security/secretVault.js';

/** The original immutable release identity remains the fallback for other code releases. */
export function createProductionConfigIdentityView(options: {
  environment: string;
  configPath: string;
  releaseId?: string;
  expected?: ExpectedConfigIdentity;
  processCwd: string;
  secretVault: SecretVault;
}) {
  const enabled = options.environment === 'production';
  if (enabled && existsSync(authorityDirectory(options.configPath)) && !options.expected) {
    throw new Error(
      'Production online configuration requires an independently bound release identity',
    );
  }
  const unavailable = (summary: ConfigIdentitySummary): ConfigIdentitySummary => {
    const { observed: _observed, reason: _reason, ...rest } = summary;
    return { ...rest, status: 'not_collected' };
  };
  const mapSummary = (summary: ConfigIdentitySummary): ConfigIdentitySummary => {
    if (!enabled) return summary;
    try {
      const state = assertPublishedDisk(options.configPath);
      if (!state) return summary;
      const expected = publishedExpected(
        options.configPath,
        options.releaseId,
        options.expected,
        false,
      );
      if (!expected) return unavailable(summary);
      const mapped = { ...summary, expected };
      if (state.phase !== 'committed') return unavailable(mapped);
      const observation = summary.observed
        ? {
            ...summary.observed,
            credentialVersionDigest: summary.observed.credentialVersionDigest ?? null,
            unresolvedRefPaths: [],
            computedAt: summary.lastObservedAt ?? new Date(0).toISOString(),
          }
        : undefined;
      const evaluation = evaluateConfigIdentityStatus(expected, observation);
      const { reason: _reason, ...rest } = mapped;
      return {
        ...rest,
        status: evaluation.status,
        ...(evaluation.reason ? { reason: evaluation.reason } : {}),
      };
    } catch {
      // Retain a bound expected side so readiness cannot mistake absent evidence for readiness.
      return unavailable(summary);
    }
  };
  return {
    mapSummary,
    isExecutionAllowed: () => {
      if (!enabled) return true;
      try {
        const state = assertPublishedDisk(options.configPath);
        return !state || state.phase === 'committed';
      } catch {
        return false;
      }
    },
    validatePublishedReload: async (next: AppConfig): Promise<void> => {
      if (!enabled) return;
      const state = assertPublishedDisk(options.configPath);
      if (!state) return;
      const expected = publishedExpected(
        options.configPath,
        options.releaseId,
        options.expected,
        false,
      );
      const observed = await computeObservedConfigIdentity(
        next,
        options.secretVault,
        options.processCwd,
      );
      if (evaluateConfigIdentityStatus(expected, observed).status !== 'consistent') {
        throw new Error('候选配置不匹配已签名的发布身份');
      }
      // Do not accept an observation computed across a competing authority change.
      const after = readPublication(options.configPath);
      if (!after || after.sequence !== state.sequence || after.revision !== state.revision) {
        throw new Error('配置发布版本在校验期间发生变化');
      }
    },
  };
}
