import type { AccessEvaluationRequest, PolicyProvider, PolicyProviderResult } from '../types.js';

export class RuntimeApprovalPolicy implements PolicyProvider {
  readonly layer = 'runtime_approval' as const;

  async evaluate(request: AccessEvaluationRequest): Promise<PolicyProviderResult> {
    const approval = request.context?.runtimeApproval;
    if (!approval?.required) {
      return { layer: this.layer, result: 'not_applicable', reasonCode: 'RUNTIME_APPROVAL_NOT_REQUIRED' };
    }
    if (approval.approved !== true) {
      return {
        layer: this.layer,
        result: 'condition',
        reasonCode: 'RUNTIME_APPROVAL_REQUIRED',
        nextAction: 'request_runtime_approval',
      };
    }
    return { layer: this.layer, result: 'pass', reasonCode: 'RUNTIME_APPROVAL_GRANTED' };
  }
}
