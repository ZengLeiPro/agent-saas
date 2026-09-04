import { governanceV36OrgGroupAgentStatements } from './v36OrgGroupAgentMigration.js';
import { governanceV37DeliveryAttemptPhaseStatements } from './v37DeliveryAttemptPhaseMigration.js';
import { governanceV38SkillPresentationStatements } from './v38SkillPresentationMigration.js';
import { governanceV39OrgGroupBindingIdentityStatements } from './v39OrgGroupBindingIdentityMigration.js';
import { governanceV40DwsDeliveryAccountIdentityStatements } from './v40DwsDeliveryAccountIdentityMigration.js';

export function governanceLatestMigrations(prefix: string) {
  return [
    { version: 36, statements: governanceV36OrgGroupAgentStatements(prefix) },
    { version: 37, statements: governanceV37DeliveryAttemptPhaseStatements(prefix) },
    { version: 38, statements: governanceV38SkillPresentationStatements(prefix) },
    { version: 39, statements: governanceV39OrgGroupBindingIdentityStatements(prefix) },
    { version: 40, statements: governanceV40DwsDeliveryAccountIdentityStatements(prefix) },
  ];
}
