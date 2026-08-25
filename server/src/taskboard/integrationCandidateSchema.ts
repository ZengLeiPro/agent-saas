/**
 * Names of historical Candidate tables.  They are retained solely for the
 * one-way legacyIntegrationAgentMigration read bridge; startup never creates
 * or mutates any of these tables.
 */
export interface IntegrationCandidateTableNames {
  candidatesTable: string;
  revisionsTable: string;
}

export function integrationCandidateTableNames(integrationSourcesTable: string): IntegrationCandidateTableNames {
  const root = integrationSourcesTable.endsWith('_sources')
    ? integrationSourcesTable.slice(0, -'_sources'.length)
    : integrationSourcesTable;
  return {
    candidatesTable: `${root}_candidates`,
    revisionsTable: `${root}_candidate_revisions`,
  };
}
