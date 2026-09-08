export interface ConnectionSettings {
  baseUrl: string;
  origin: string;
  diagnostic?: { readOnlyCapabilityId: string; readOnlyInput: Record<string, unknown> };
}
export interface ConnectionSettingsRecord {
  settings: ConnectionSettings;
  version: number;
}
export interface ConnectionOptions extends ConnectionSettingsRecord {
  published: boolean;
  publishedDigest: string | null;
  organizations: Array<{
    id: string;
    name: string;
    connection: {
      installationId: string;
      status: string;
      executionId: string | null;
    } | null;
  }>;
}
export interface OrganizationConnectionOptions {
  tenant: { id: string; name: string };
  eligible: boolean;
  members: Array<{ userId: string; name: string; isAdmin: boolean }>;
  installation: { installationId: string; status: string } | null;
}
export const resolveConnectionAddress = (template: string, tenantId: string, systemId: string) =>
  template.replaceAll('{tenantId}', tenantId).replaceAll('{systemId}', systemId);
