import { migrationSourceDigest } from './migration-reviews.mjs';
import { POSTCONDITIONS_PATH } from './migration-postconditions.mjs';

// Synthetic classifier fixtures only; runtime/database assertions have separate PG tests.
export function withPostconditionFixtures(baselines, targets) {
  return {
    ...targets,
    [POSTCONDITIONS_PATH]: JSON.stringify({
      schemaVersion: 1,
      entries: Object.entries(targets)
        .filter(([path]) => /\.(?:ts|sql|mts)$/u.test(path))
        .map(([path, source], index) => ({
          path,
          baselineDigest: migrationSourceDigest(baselines[path] ?? null),
          targetDigest: migrationSourceDigest(source),
          checks: [
            {
              id: `fixture-${index}`,
              description: 'Synthetic classifier fixture',
              configPath: 'runtimeEventStore',
              sql: 'SELECT true AS ok',
              params: [],
            },
          ],
        })),
    }),
  };
}
