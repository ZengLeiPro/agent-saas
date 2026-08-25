export function governanceV28Statements(assignments: string): string[] {
  return [
    `ALTER TABLE ${assignments} DROP CONSTRAINT IF EXISTS ${assignments}_resource_type_check`,
    `ALTER TABLE ${assignments} ADD CONSTRAINT ${assignments}_resource_type_check CHECK (
      resource_type IN ('org_agent','skill','credential','environment_template','org_knowledge','connector','org_memory','dws_delegation')
    )`,
  ];
}
