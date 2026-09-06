import { governanceV36OrgGroupAgentStatements } from './v36OrgGroupAgentMigration.js';
import { governanceV37DeliveryAttemptPhaseStatements } from './v37DeliveryAttemptPhaseMigration.js';
import { governanceV38SkillPresentationStatements } from './v38SkillPresentationMigration.js';
import { governanceV39OrgGroupBindingIdentityStatements } from './v39OrgGroupBindingIdentityMigration.js';
import { governanceV40DwsDeliveryAccountIdentityStatements } from './v40DwsDeliveryAccountIdentityMigration.js';
import { governanceV41KyAppSystemStatements } from './v41KyAppSystemMigration.js';
import { governanceV43KyAppSessionToolSnapshotStatements } from './v43KyAppSessionToolSnapshotMigration.js';

export function governanceLatestMigrations(prefix: string) {
  return [
    { version: 36, statements: governanceV36OrgGroupAgentStatements(prefix) },
    { version: 37, statements: governanceV37DeliveryAttemptPhaseStatements(prefix) },
    { version: 38, statements: governanceV38SkillPresentationStatements(prefix) },
    { version: 39, statements: governanceV39OrgGroupBindingIdentityStatements(prefix) },
    { version: 40, statements: governanceV40DwsDeliveryAccountIdentityStatements(prefix) },
    { version: 41, statements: governanceV41KyAppSystemStatements(prefix) },
    // 42 = WP2b 目录变更流（并行分支 feat/ky-app-wp2b），本分支缺号，合并后补齐。
    { version: 43, statements: governanceV43KyAppSessionToolSnapshotStatements(prefix) },
  ];
}
