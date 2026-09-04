import type { SkillsRouterDeps } from '../routes/skills.js';
import type { AppRuntime } from './runtimeContracts.js';

export function buildSkillsRouterDeps(input: {
  runtime: AppRuntime;
  agentCwd: string;
  sharedDir: string;
  legacyWriteGate: SkillsRouterDeps['legacyWriteGate'];
}): SkillsRouterDeps {
  return {
    skillConfigStore: input.runtime.skillConfigStore!,
    userStore: input.runtime.userStore!,
    agentCwd: input.agentCwd,
    sharedDir: input.sharedDir,
    tenantSkillsRootDir: input.runtime.tenantSkillsRootDir,
    skillMaterialization: input.runtime.skillMaterialization,
    skillGovernanceStore: input.runtime.skillGovernanceStore,
    skillPresentationStore: input.runtime.skillPresentationStore,
    governanceAuditStore: input.runtime.governanceAuditStore,
    legacyWriteGate: input.legacyWriteGate,
  };
}
