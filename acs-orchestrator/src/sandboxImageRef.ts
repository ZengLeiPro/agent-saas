import type { SandboxStatus } from './sandboxState.js';
import { stringValue } from './sandboxState.js';

export function sandboxImageRef(status: SandboxStatus, containerName: string): string | undefined {
    const raw = status.raw ?? {};
    const spec = raw.spec && typeof raw.spec === 'object' ? raw.spec as Record<string, unknown> : {};
    const template = spec.template && typeof spec.template === 'object' ? spec.template as Record<string, unknown> : {};
    const podSpec = template.spec && typeof template.spec === 'object' ? template.spec as Record<string, unknown> : {};
    const containers = Array.isArray(podSpec.containers) ? podSpec.containers : [];
    const container = containers.find((item): item is Record<string, unknown> => (
      Boolean(item)
      && typeof item === 'object'
      && (!('name' in item) || item.name === containerName)
    ));
    return container ? stringValue(container.image) : undefined;
  }
