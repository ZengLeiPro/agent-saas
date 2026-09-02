import { evaluateMobileCompatibility, type SignedMobileCompatibilityPolicy } from './policy';

export interface MobileContractFixture {
  apiVersion: number;
  cacheSchemaVersion: number;
  submission: { clientMsgId: string; draft: string; unknownServerField?: unknown };
  sync: { epoch: string; seq: number; events: Array<{ type: string; [key: string]: unknown }> };
  cache: { sessions: Array<{ id: string; title: string; [key: string]: unknown }> };
}

/** N-1 reader intentionally projects only known fields; additive N fields are ignored. */
export function readNMinusOneFixture(value: MobileContractFixture): MobileContractFixture {
  return {
    apiVersion: value.apiVersion,
    cacheSchemaVersion: value.cacheSchemaVersion,
    submission: { clientMsgId: value.submission.clientMsgId, draft: value.submission.draft },
    sync: { epoch: value.sync.epoch, seq: value.sync.seq, events: value.sync.events.map((event) => ({ type: event.type })) },
    cache: { sessions: value.cache.sessions.map((session) => ({ id: session.id, title: session.title })) },
  };
}

export function evaluateFixtureClient(policy: SignedMobileCompatibilityPolicy, appVersion: string, fixture: MobileContractFixture) {
  return evaluateMobileCompatibility(policy, {
    tenantId: policy.tenantId, environment: policy.environment, appId: policy.appId,
    appVersion, apiVersion: fixture.apiVersion, cacheSchemaVersion: fixture.cacheSchemaVersion,
  }, Date.parse(policy.effectiveAt) + 1);
}

/** One authoritative additive N fixture consumed by old-client contract tests across packages. */
export const MOBILE_N_MINUS_ONE_N_FIXTURE: MobileContractFixture = Object.freeze({
  apiVersion: 2,
  cacheSchemaVersion: 1,
  submission: { clientMsgId: 'm70-02-old-client-1', draft: 'old client submission', unknownServerField: { introducedInN: true } },
  sync: { epoch: 'epoch-n', seq: 9, events: [{ type: 'message', introducedInN: 'ignored-by-n-minus-one' }] },
  cache: { sessions: [{ id: 'session-n-minus-one', title: 'known title', introducedInN: 'ignored-by-n-minus-one' }] },
});
