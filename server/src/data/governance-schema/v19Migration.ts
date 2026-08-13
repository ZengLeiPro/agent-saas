export function governanceV19Statements(input: {
  assignmentSets: string;
  assignments: string;
}): string[] {
  const { assignmentSets, assignments } = input;
  return [
    `ALTER TABLE ${assignmentSets} ADD COLUMN IF NOT EXISTS resource_name TEXT`,
    `ALTER TABLE ${assignmentSets} ADD COLUMN IF NOT EXISTS resource_status TEXT NOT NULL DEFAULT 'enabled'`,
    `ALTER TABLE ${assignmentSets} ALTER COLUMN resource_status SET DEFAULT 'enabled'`,
    `UPDATE ${assignmentSets}
      SET resource_status='enabled'
      WHERE resource_status IS NULL`,
    `ALTER TABLE ${assignmentSets} ALTER COLUMN resource_status SET NOT NULL`,
    `ALTER TABLE ${assignmentSets} DROP CONSTRAINT IF EXISTS ${assignmentSets}_resource_status_check`,
    `ALTER TABLE ${assignmentSets} ADD CONSTRAINT ${assignmentSets}_resource_status_check
      CHECK (resource_status IN ('enabled','disabled'))`,
    `UPDATE ${assignmentSets}
      SET resource_name='Migrated org memory ' || LEFT(MD5(tenant_id || ':' || resource_id),12)
      WHERE resource_type='org_memory' AND NULLIF(BTRIM(resource_name),'') IS NULL`,
    `ALTER TABLE ${assignmentSets} DROP CONSTRAINT IF EXISTS ${assignmentSets}_org_memory_metadata_check`,
    `ALTER TABLE ${assignmentSets} ADD CONSTRAINT ${assignmentSets}_org_memory_metadata_check
      CHECK (resource_type <> 'org_memory' OR (resource_name IS NOT NULL AND BTRIM(resource_name) <> ''))`,
    `ALTER TABLE ${assignments} DROP CONSTRAINT IF EXISTS ${assignments}_resource_type_check`,
    `ALTER TABLE ${assignments} ADD CONSTRAINT ${assignments}_resource_type_check CHECK (
      resource_type IN ('org_agent','skill','credential','environment_template','org_knowledge','connector','org_memory')
    )`,
    `CREATE INDEX IF NOT EXISTS ${assignmentSets}_memory_catalog_idx
      ON ${assignmentSets} (tenant_id,resource_status,resource_id) WHERE resource_type='org_memory'`,
  ];
}
