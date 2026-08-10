import { getActionDefinition } from '../actionCatalog.js';
import type { AccessEvaluationRequest, PolicyProvider, PolicyProviderResult } from '../types.js';

const SERVICE_ACTIONS = new Map<string, ReadonlySet<string>>([
  ['runtime_worker', new Set(['org_agent.run', 'personal_agent.run', 'skill.use', 'connector.use', 'credential.use', 'environment.use', 'org_knowledge.use'])],
  ['credential_broker', new Set(['credential.use'])],
  ['memory_consolidator', new Set(['personal_memory.manage'])],
  ['retention_worker', new Set<string>()],
  ['migration_worker', new Set<string>()],
]);

export class PersonaPolicy implements PolicyProvider {
  readonly layer = 'persona' as const;

  async evaluate(request: AccessEvaluationRequest): Promise<PolicyProviderResult> {
    const definition = getActionDefinition(request.action);
    if (!definition) return this.deny('ACTION_NOT_CATALOGED');
    const { subject } = request;
    if (subject.subjectType === 'service') {
      const allowed = SERVICE_ACTIONS.get(subject.serviceId)?.has(request.action) === true;
      if (!allowed) return this.deny('SERVICE_ACTION_NOT_ALLOWED');
      if (!subject.delegatedUserId && definition.authority !== 'platform') {
        return this.deny('SERVICE_DELEGATED_USER_REQUIRED');
      }
      return this.pass('SERVICE_PURPOSE_ALLOWED');
    }
    if (definition.authority === 'platform') {
      return subject.persona === 'platform_admin'
        ? this.pass('PLATFORM_ADMIN_ALLOWED')
        : this.deny('PLATFORM_ADMIN_REQUIRED');
    }
    if (definition.authority === 'owner') {
      return subject.isOwner ? this.pass('OWNER_ALLOWED') : this.deny('OWNER_REQUIRED');
    }
    if (definition.authority === 'tenant') {
      return subject.persona === 'org_admin'
        ? this.pass(subject.isOwner ? 'OWNER_ALLOWED' : 'ORG_ADMIN_ALLOWED')
        : this.deny('ORG_ADMIN_REQUIRED');
    }
    if (definition.authority === 'personal') {
      return request.resource.ownerUserId === subject.subjectId
        ? this.pass('PERSONAL_OWNER_ALLOWED')
        : this.deny('PERSONAL_OWNER_REQUIRED');
    }
    return this.pass('RESOURCE_USE_PERSONA_ALLOWED');
  }

  private pass(reasonCode: string): PolicyProviderResult {
    return { layer: this.layer, result: 'pass', reasonCode };
  }

  private deny(reasonCode: string): PolicyProviderResult {
    return { layer: this.layer, result: 'deny', reasonCode };
  }
}
