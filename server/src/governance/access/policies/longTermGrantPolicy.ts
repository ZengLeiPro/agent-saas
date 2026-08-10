import type { AccessEvaluationRequest, PolicyProvider, PolicyProviderResult } from '../types.js';

export class LongTermGrantPolicy implements PolicyProvider {
  readonly layer = 'long_term_grant' as const;

  async evaluate(request: AccessEvaluationRequest): Promise<PolicyProviderResult> {
    const grant = request.context?.longTermGrant;
    if (!grant?.required) {
      return { layer: this.layer, result: 'not_applicable', reasonCode: 'LONG_TERM_GRANT_NOT_REQUIRED' };
    }
    if (grant.active !== true) {
      return {
        layer: this.layer,
        result: 'condition',
        reasonCode: 'USER_AUTHORIZATION_REQUIRED',
        nextAction: 'authorize_resource',
        ...(grant.generation !== undefined ? {
          sourceVersion: grant.generation,
          snapshot: { grantGeneration: grant.generation },
        } : {}),
      };
    }
    return {
      layer: this.layer,
      result: 'pass',
      reasonCode: 'LONG_TERM_GRANT_ACTIVE',
      ...(grant.generation !== undefined ? {
        sourceVersion: grant.generation,
        snapshot: { grantGeneration: grant.generation },
      } : {}),
    };
  }
}
