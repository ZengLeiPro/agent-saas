import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  EffectiveWorkflowDisplayConfig,
  WorkflowDisplayPolicy,
  WorkflowDisplayScope,
} from '../../../../shared/src/types/workflowDisplay.js';
import { authLogger } from '../../utils/logger.js';
import type { UpsertWorkflowDisplayPolicyInput, WorkflowDisplayPoliciesFileData } from './types.js';

const PLATFORM_DEFAULT_DISPLAY_COUNT = 3;

function clonePolicy(policy: WorkflowDisplayPolicy): WorkflowDisplayPolicy {
  return { ...policy, workflowIds: [...policy.workflowIds] };
}

export function normalizeWorkflowPosition(value: string | undefined | null): string {
  return value?.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('zh-CN') ?? '';
}

export class WorkflowDisplayPolicyConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super('WORKFLOW_DISPLAY_POLICY_CONFLICT');
    this.name = 'WorkflowDisplayPolicyConflictError';
  }
}

export class WorkflowDisplayPolicyStore {
  private policies: WorkflowDisplayPolicy[] = [];
  private writeTail: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) {
      mkdirSync(dirname(this.filePath), { recursive: true });
      this.policies = [];
      return;
    }
    try {
      const data = JSON.parse(
        readFileSync(this.filePath, 'utf-8'),
      ) as WorkflowDisplayPoliciesFileData;
      this.policies =
        data.version === 1 && Array.isArray(data.policies) ? data.policies.map(clonePolicy) : [];
    } catch (error) {
      authLogger.warn(`Failed to load workflow display policies: ${error}`);
      this.policies = [];
    }
  }

  private async persist(): Promise<void> {
    const data: WorkflowDisplayPoliciesFileData = { version: 1, policies: this.policies };
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tempPath = join(
      dirname(this.filePath),
      `.workflow-display.${randomBytes(6).toString('hex')}.tmp`,
    );
    await writeFile(tempPath, JSON.stringify(data, null, 2), { mode: 0o600 });
    try {
      await rename(tempPath, this.filePath);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeTail.then(operation);
    this.writeTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  listByTenant(tenantId: string): WorkflowDisplayPolicy[] {
    this.load();
    return this.policies.filter((policy) => policy.tenantId === tenantId).map(clonePolicy);
  }

  get(
    tenantId: string,
    scope: WorkflowDisplayScope,
    subjectId: string,
  ): WorkflowDisplayPolicy | undefined {
    this.load();
    const policy = this.policies.find(
      (candidate) =>
        candidate.tenantId === tenantId &&
        candidate.scope === scope &&
        candidate.subjectId === subjectId,
    );
    return policy ? clonePolicy(policy) : undefined;
  }

  resolve(input: {
    tenantId: string;
    userId: string;
    position?: string;
  }): EffectiveWorkflowDisplayConfig {
    this.load();
    const candidates: Array<[WorkflowDisplayScope, string]> = [
      ['user', input.userId],
      ...(normalizeWorkflowPosition(input.position)
        ? [
            ['position', normalizeWorkflowPosition(input.position)] as [
              WorkflowDisplayScope,
              string,
            ],
          ]
        : []),
      ['tenant', input.tenantId],
    ];
    for (const [scope, subjectId] of candidates) {
      const policy = this.policies.find(
        (candidate) =>
          candidate.tenantId === input.tenantId &&
          candidate.scope === scope &&
          candidate.subjectId === subjectId,
      );
      if (policy) {
        return {
          source: scope,
          displayCount: policy.displayCount,
          workflowIds: [...policy.workflowIds],
          revision: policy.revision,
        };
      }
    }
    return {
      source: 'platform',
      displayCount: PLATFORM_DEFAULT_DISPLAY_COUNT,
      workflowIds: [],
      revision: 0,
    };
  }

  async upsert(input: UpsertWorkflowDisplayPolicyInput): Promise<WorkflowDisplayPolicy> {
    return this.enqueue(async () => {
      this.load();
      const index = this.policies.findIndex(
        (candidate) =>
          candidate.tenantId === input.tenantId &&
          candidate.scope === input.scope &&
          candidate.subjectId === input.subjectId,
      );
      const current = index >= 0 ? this.policies[index] : undefined;
      const currentRevision = current?.revision ?? 0;
      if (currentRevision !== input.expectedRevision) {
        throw new WorkflowDisplayPolicyConflictError(currentRevision);
      }
      const now = new Date().toISOString();
      const next: WorkflowDisplayPolicy = {
        tenantId: input.tenantId,
        scope: input.scope,
        subjectId: input.subjectId,
        subjectLabel: input.subjectLabel,
        displayCount: input.displayCount,
        workflowIds: [...input.workflowIds],
        revision: currentRevision + 1,
        createdAt: current?.createdAt ?? now,
        createdBy: current?.createdBy ?? input.actorId,
        updatedAt: now,
        updatedBy: input.actorId,
      };
      if (index >= 0) this.policies[index] = next;
      else this.policies.push(next);
      await this.persist();
      return clonePolicy(next);
    });
  }

  async remove(input: {
    tenantId: string;
    scope: WorkflowDisplayScope;
    subjectId: string;
    expectedRevision: number;
  }): Promise<boolean> {
    return this.enqueue(async () => {
      this.load();
      const index = this.policies.findIndex(
        (candidate) =>
          candidate.tenantId === input.tenantId &&
          candidate.scope === input.scope &&
          candidate.subjectId === input.subjectId,
      );
      if (index < 0) return false;
      const current = this.policies[index]!;
      if (current.revision !== input.expectedRevision) {
        throw new WorkflowDisplayPolicyConflictError(current.revision);
      }
      this.policies.splice(index, 1);
      await this.persist();
      return true;
    });
  }
}
