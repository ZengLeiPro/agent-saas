import { PLATFORM_TOOL_CATALOG, PLATFORM_TOOL_CATALOG_BY_ID } from '../agent/toolCatalog.js';
import type { AssignmentResourceType } from '../data/assignments/index.js';
import type { EntitlementResourceType } from '../data/entitlements/types.js';
import type { AppRuntime } from './runtime.js';

export function createAssignmentResourceResolver(runtime: AppRuntime) {
  return async (
    tenantId: string,
    resourceType: AssignmentResourceType,
    resourceId: string,
  ): Promise<'valid' | 'not_found' | 'unavailable'> => {
    if (resourceType === 'org_agent') {
      if (!runtime.agentResourceStore) return 'unavailable';
      const resource = await runtime.agentResourceStore.getForTenant(tenantId, resourceId);
      return resource?.kind === 'org_agent' && resource.status === 'enabled' ? 'valid' : 'not_found';
    }
    if (resourceType === 'skill') {
      if (!runtime.skillGovernanceStore) return 'unavailable';
      const resource = await runtime.skillGovernanceStore.getResource(resourceId);
      return resource && resource.scope !== 'personal' && resource.status === 'published'
        && (resource.scope === 'platform' || resource.tenantId === tenantId) ? 'valid' : 'not_found';
    }
    if (resourceType === 'credential') {
      if (!runtime.credentialStore) return 'unavailable';
      const resource = await runtime.credentialStore.get(resourceId);
      return resource?.tenantId === tenantId && resource.kind === 'org_shared' && resource.status === 'active'
        ? 'valid' : 'not_found';
    }
    if (resourceType === 'environment_template') {
      if (!runtime.environmentStore) return 'unavailable';
      return (await runtime.environmentStore.getTemplate(resourceId))?.status === 'published' ? 'valid' : 'not_found';
    }
    if (resourceType === 'dws_delegation') {
      if (!runtime.agentDwsAccountStore) return 'unavailable';
      const match = /^dws-delegation:([A-Za-z0-9_-]{1,160}):[0-9a-f]{64}$/.exec(resourceId);
      if (!match) return 'not_found';
      const account = await runtime.agentDwsAccountStore.getForTenant(tenantId, match[1]!);
      return account?.status === 'active' && Boolean(account.profileId) ? 'valid' : 'not_found';
    }
    if (resourceType === 'connector') {
      if (!runtime.connectorCatalogStore) return 'unavailable';
      return (await runtime.connectorCatalogStore.get(resourceId))?.status === 'published' ? 'valid' : 'not_found';
    }
    if (resourceType === 'org_knowledge') {
      if (!runtime.contextStore) return 'unavailable';
      const collection = (await runtime.contextStore.listCollections(tenantId))
        .find(item => item.collectionId === resourceId);
      return collection?.status === 'active' ? 'valid' : 'not_found';
    }
    return 'unavailable';
  };
}

export function createEntitlementResourceCatalogResolver(runtime: AppRuntime) {
  return async (
    resourceType: EntitlementResourceType,
  ): Promise<{ status: 'valid'; items: Array<{ resourceId: string; version: number }> } | { status: 'unavailable' }> => {
    if (resourceType === 'model') {
      if (!runtime.config.models) return { status: 'unavailable' };
      return {
        status: 'valid',
        items: runtime.config.models.groups.flatMap(group => group.models.map(model => ({
          resourceId: `${group.id}/${model.id}`,
          version: 1,
        }))),
      };
    }
    if (resourceType === 'tool') {
      return {
        status: 'valid',
        items: PLATFORM_TOOL_CATALOG.map(tool => ({ resourceId: tool.id, version: 1 })),
      };
    }
    if (resourceType === 'agent_template') {
      if (!runtime.agentResourceStore) return { status: 'unavailable' };
      return { status: 'valid', items: (await runtime.agentResourceStore.listByKind('agent_template'))
        .filter(item => item.status === 'enabled')
        .map(item => ({ resourceId: item.agentId, version: item.revision })) };
    }
    if (resourceType === 'skill') {
      if (!runtime.skillGovernanceStore) return { status: 'unavailable' };
      return { status: 'valid', items: (await runtime.skillGovernanceStore.listPublishedPlatform())
        .map(item => ({ resourceId: item.skillId, version: item.revision })) };
    }
    if (resourceType === 'connector') {
      if (!runtime.connectorCatalogStore) return { status: 'unavailable' };
      return { status: 'valid', items: (await runtime.connectorCatalogStore.list())
        .filter(item => item.status === 'published')
        .map(item => ({ resourceId: item.connectorId, version: item.version })) };
    }
    if (resourceType === 'environment_template') {
      if (!runtime.environmentStore) return { status: 'unavailable' };
      return { status: 'valid', items: (await runtime.environmentStore.listTemplates())
        .filter(item => item.status === 'published')
        .map(item => ({ resourceId: item.templateId, version: item.revision })) };
    }
    return { status: 'unavailable' };
  };
}

export function createEntitlementResourceResolver(runtime: AppRuntime) {
  return async (
    resourceType: EntitlementResourceType,
    resourceId: string,
  ): Promise<{ status: 'valid'; version: number } | { status: 'not_found' | 'unavailable' }> => {
    if (resourceType === 'model') {
      if (!runtime.config.models) return { status: 'unavailable' };
      const exists = runtime.config.models.groups.some(group =>
        group.models.some(model => `${group.id}/${model.id}` === resourceId));
      return exists ? { status: 'valid', version: 1 } : { status: 'not_found' };
    }
    if (resourceType === 'tool') {
      return PLATFORM_TOOL_CATALOG_BY_ID.has(resourceId)
        ? { status: 'valid', version: 1 }
        : { status: 'not_found' };
    }
    if (resourceType === 'agent_template') {
      if (!runtime.agentResourceStore) return { status: 'unavailable' };
      const item = (await runtime.agentResourceStore.listByKind('agent_template'))
        .find(resource => resource.agentId === resourceId && resource.status === 'enabled');
      return item ? { status: 'valid', version: item.revision } : { status: 'not_found' };
    }
    if (resourceType === 'skill') {
      if (!runtime.skillGovernanceStore) return { status: 'unavailable' };
      const item = await runtime.skillGovernanceStore.getResource(resourceId);
      return item?.scope === 'platform' && item.status === 'published'
        ? { status: 'valid', version: item.revision } : { status: 'not_found' };
    }
    if (resourceType === 'connector') {
      if (!runtime.connectorCatalogStore) return { status: 'unavailable' };
      const item = await runtime.connectorCatalogStore.get(resourceId);
      return item?.status === 'published' ? { status: 'valid', version: item.version } : { status: 'not_found' };
    }
    if (resourceType === 'environment_template') {
      if (!runtime.environmentStore) return { status: 'unavailable' };
      const item = await runtime.environmentStore.getTemplate(resourceId);
      return item?.status === 'published' ? { status: 'valid', version: item.revision } : { status: 'not_found' };
    }
    return { status: 'unavailable' };
  };
}
