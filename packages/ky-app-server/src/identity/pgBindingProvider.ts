import type { InstallationBinding, InstallationBindingState } from '@kaiyan/ky-app-contract';
import type { Pool } from 'pg';

import type { BindingChange, InstallationBindingProvider } from './types.js';

interface BindingRow {
  installation_id: string;
  tenant_id: string;
  system_id: string;
  deployment_id: string;
  origin: string;
  platform_issuer: string;
  platform_api_base_url: string;
  key_id: string;
  granted_scopes: string[];
  registered_digest: string | null;
  generation: string;
  state: InstallationBindingState;
  updated_at: Date;
}

const columns = `installation_id, tenant_id, system_id, deployment_id, origin,
  platform_issuer, platform_api_base_url, key_id, granted_scopes, registered_digest,
  generation, state, updated_at`;

function binding(row: BindingRow): InstallationBinding {
  return {
    installationId: row.installation_id,
    tenantId: row.tenant_id,
    systemId: row.system_id,
    deploymentId: row.deployment_id,
    origin: row.origin,
    platformIssuer: row.platform_issuer,
    platformApiBaseUrl: row.platform_api_base_url,
    keyId: row.key_id,
    grantedScopes: row.granted_scopes,
    registeredDigest: row.registered_digest,
    generation: Number(row.generation),
    state: row.state,
    updatedAt: row.updated_at.toISOString(),
  };
}

export class PgInstallationBindingProvider implements InstallationBindingProvider {
  private readonly listeners = new Set<(change: BindingChange) => void>();

  constructor(private readonly pool: Pool) {}

  async get(installationId: string): Promise<InstallationBinding | null> {
    const result = await this.pool.query<BindingRow>(
      `SELECT ${columns} FROM ky_app_installation_bindings WHERE installation_id = $1`,
      [installationId],
    );
    return result.rowCount === 1 ? binding(result.rows[0]) : null;
  }

  async list(): Promise<InstallationBinding[]> {
    const result = await this.pool.query<BindingRow>(
      `SELECT ${columns} FROM ky_app_installation_bindings ORDER BY installation_id`,
    );
    return result.rows.map(binding);
  }

  async stage(value: InstallationBinding): Promise<void> {
    const result = await this.pool.query<BindingRow>(
      `INSERT INTO ky_app_installation_binding_stages
       (installation_id, tenant_id, system_id, deployment_id, origin, platform_issuer,
        platform_api_base_url, key_id, granted_scopes, registered_digest, generation, state, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,'activating',$12)
       ON CONFLICT (installation_id) DO UPDATE SET
         tenant_id=EXCLUDED.tenant_id, system_id=EXCLUDED.system_id,
         deployment_id=EXCLUDED.deployment_id, origin=EXCLUDED.origin,
         platform_issuer=EXCLUDED.platform_issuer,
         platform_api_base_url=EXCLUDED.platform_api_base_url, key_id=EXCLUDED.key_id,
         granted_scopes=EXCLUDED.granted_scopes, registered_digest=EXCLUDED.registered_digest,
         generation=EXCLUDED.generation, state='activating', updated_at=EXCLUDED.updated_at
       WHERE ky_app_installation_binding_stages.generation <= EXCLUDED.generation
         AND NOT EXISTS (
           SELECT 1 FROM ky_app_installation_bindings active
           WHERE active.installation_id=EXCLUDED.installation_id
             AND active.generation >= EXCLUDED.generation
         )
       RETURNING ${columns}`,
      [
        value.installationId,
        value.tenantId,
        value.systemId,
        value.deploymentId,
        value.origin,
        value.platformIssuer,
        value.platformApiBaseUrl,
        value.keyId,
        JSON.stringify(value.grantedScopes),
        value.registeredDigest,
        value.generation,
        value.updatedAt,
      ],
    );
    if (result.rowCount !== 1) throw new Error('binding_generation_conflict');
    this.emit({ type: 'staged', binding: binding(result.rows[0]) });
  }

  async activate(installationId: string, expectedGeneration: number): Promise<void> {
    const result = await this.pool.query<BindingRow>(
      `WITH candidate AS (
         DELETE FROM ky_app_installation_binding_stages
         WHERE installation_id=$1 AND generation=$2
         RETURNING installation_id, tenant_id, system_id, deployment_id, origin,
           platform_issuer, platform_api_base_url, key_id, granted_scopes,
           registered_digest, generation
       )
       INSERT INTO ky_app_installation_bindings
         (installation_id, tenant_id, system_id, deployment_id, origin, platform_issuer,
          platform_api_base_url, key_id, granted_scopes, registered_digest, generation, state, updated_at)
       SELECT installation_id, tenant_id, system_id, deployment_id, origin, platform_issuer,
          platform_api_base_url, key_id, granted_scopes, registered_digest, generation, 'connected', now()
       FROM candidate
       ON CONFLICT (installation_id) DO UPDATE SET
         tenant_id=EXCLUDED.tenant_id, system_id=EXCLUDED.system_id,
         deployment_id=EXCLUDED.deployment_id, origin=EXCLUDED.origin,
         platform_issuer=EXCLUDED.platform_issuer,
         platform_api_base_url=EXCLUDED.platform_api_base_url, key_id=EXCLUDED.key_id,
         granted_scopes=EXCLUDED.granted_scopes, registered_digest=EXCLUDED.registered_digest,
         generation=EXCLUDED.generation, state='connected', updated_at=now()
       WHERE ky_app_installation_bindings.generation < EXCLUDED.generation
       RETURNING ${columns}`,
      [installationId, expectedGeneration],
    );
    if (result.rowCount !== 1) throw new Error('binding_generation_conflict');
    this.emit({ type: 'activated', binding: binding(result.rows[0]) });
  }

  async revoke(installationId: string, expectedGeneration: number): Promise<void> {
    const result = await this.pool.query(
      `UPDATE ky_app_installation_bindings SET state='revoked', updated_at=now()
       WHERE installation_id=$1 AND generation=$2 AND state <> 'revoked'`,
      [installationId, expectedGeneration],
    );
    if (result.rowCount !== 1) throw new Error('binding_generation_conflict');
    this.emit({ type: 'revoked', installationId, generation: expectedGeneration });
  }

  subscribe(listener: (change: BindingChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(change: BindingChange): void {
    for (const listener of this.listeners) listener(change);
  }
}
