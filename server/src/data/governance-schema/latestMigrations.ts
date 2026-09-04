import { governanceV36OrgGroupAgentStatements } from './v36OrgGroupAgentMigration.js';
import { governanceV37DeliveryAttemptPhaseStatements } from './v37DeliveryAttemptPhaseMigration.js';
import { governanceV38SkillPresentationStatements } from './v38SkillPresentationMigration.js';

export function governanceLatestMigrations(prefix: string) {
  return [
    { version: 36, statements: governanceV36OrgGroupAgentStatements(prefix) },
    { version: 37, statements: governanceV37DeliveryAttemptPhaseStatements(prefix) },
    { version: 38, statements: governanceV38SkillPresentationStatements(prefix) },
  ];
}
