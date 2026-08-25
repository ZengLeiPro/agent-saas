import type { PoolClient } from 'pg';

import { governanceTablePrefix, type GovernancePgPool } from '../governance-schema/index.js';
import type { SecretVault } from '../../security/secretVault.js';

export type TenantCleanupDomain =
  | 'assignments'
  | 'agents_skills'
  | 'credentials'
  | 'memberships'
  | 'tenant_configuration'
  | 'audit_retention';

export class GovernanceTenantCleanup {
  private readonly prefix: string;

  constructor(private readonly options: {
    pool: GovernancePgPool;
    tablePrefix?: string;
    vault: SecretVault;
  }) {
    this.prefix = governanceTablePrefix(options.tablePrefix);
  }

  async execute(tenantId: string, domain: TenantCleanupDomain): Promise<void> {
    switch (domain) {
      case 'assignments': return this.deleteAssignments(tenantId);
      case 'agents_skills': return this.deleteAgentsAndSkills(tenantId);
      case 'credentials': return this.revokeCredentials(tenantId);
      case 'memberships': return this.deleteMemberships(tenantId);
      case 'tenant_configuration': return this.deleteTenantConfiguration(tenantId);
      case 'audit_retention': return this.markAuditRetention(tenantId);
    }
  }

  /** Final tenant-delete verifier: no credential rows may survive a hard delete. */
  async verifyTenantDeletion(tenantId: string): Promise<{ credentials: number }> {
    const result = await this.options.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${this.prefix}_credentials WHERE tenant_id=$1`, [tenantId],
    );
    return { credentials: Number(result.rows[0]?.count ?? 0) };
  }

  private async transaction(work: (client: PoolClient) => Promise<void>): Promise<void> {
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      await work(client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async deleteAssignments(tenantId: string): Promise<void> {
    const memberships = `${this.prefix}_tenant_memberships`;
    const preferences = `${this.prefix}_user_resource_preferences`;
    const sets = `${this.prefix}_resource_assignment_sets`;
    await this.transaction(async client => {
      await client.query(
        `DELETE FROM ${preferences} WHERE user_id IN (SELECT user_id FROM ${memberships} WHERE tenant_id=$1)`,
        [tenantId],
      );
      await client.query(`DELETE FROM ${sets} WHERE tenant_id=$1`, [tenantId]);
    });
  }

  private async deleteAgentsAndSkills(tenantId: string): Promise<void> {
    const agents = `${this.prefix}_managed_agents`;
    const agentVersions = `${this.prefix}_managed_agent_versions`;
    const agentDwsAccounts = `${this.prefix}_agent_dws_accounts`;
    const skills = `${this.prefix}_governed_skills`;
    const skillVersions = `${this.prefix}_governed_skill_versions`;
    const candidates = `${this.prefix}_skill_candidates`;
    const references = `${this.prefix}_resource_references`;
    await this.transaction(async client => {
      await client.query(`DELETE FROM ${references} WHERE tenant_id=$1`, [tenantId]);
      await client.query(`DELETE FROM ${agentDwsAccounts} WHERE tenant_id=$1`, [tenantId]);
      await client.query(`UPDATE ${agents} SET current_version_id=NULL WHERE tenant_id=$1`, [tenantId]);
      await client.query(
        `DELETE FROM ${agentVersions} WHERE agent_id IN (SELECT agent_id FROM ${agents} WHERE tenant_id=$1)`, [tenantId],
      );
      await client.query(`DELETE FROM ${agents} WHERE tenant_id=$1`, [tenantId]);
      await client.query(`UPDATE ${skills} SET current_version_id=NULL WHERE tenant_id=$1`, [tenantId]);
      await client.query(
        `UPDATE ${skillVersions} SET source_candidate_id=NULL WHERE skill_id IN (SELECT skill_id FROM ${skills} WHERE tenant_id=$1)`, [tenantId],
      );
      await client.query(`DELETE FROM ${candidates} WHERE tenant_id=$1`, [tenantId]);
      await client.query(
        `DELETE FROM ${skillVersions} WHERE skill_id IN (SELECT skill_id FROM ${skills} WHERE tenant_id=$1)`, [tenantId],
      );
      await client.query(`DELETE FROM ${skills} WHERE tenant_id=$1`, [tenantId]);
    });
  }

  private async revokeCredentials(tenantId: string): Promise<void> {
    const credentials = `${this.prefix}_credentials`;
    const rows = await this.options.pool.query(
      `SELECT credential_id,secret_ref,owner_user_id FROM ${credentials} WHERE tenant_id=$1 AND status <> 'revoked'`,
      [tenantId],
    );
    for (const row of rows.rows) {
      await this.options.vault.revokeSecret(String(row.secret_ref), {
        actor: 'connector_proxy',
        userId: row.owner_user_id ? String(row.owner_user_id) : 'governance-tenant-cleanup',
        tenantId,
        scopes: ['secret:connector:revoke'],
      });
    }
    // Revocation is externally observable before the durable credential rows are
    // removed; retaining revoked rows would leave tenant credential residue.
    await this.options.pool.query(
      `DELETE FROM ${this.prefix}_credential_commits WHERE tenant_id=$1`, [tenantId],
    );
    await this.options.pool.query(`DELETE FROM ${credentials} WHERE tenant_id=$1`, [tenantId]);
  }

  private async deleteMemberships(tenantId: string): Promise<void> {
    await this.options.pool.query(
      `DELETE FROM ${this.prefix}_tenant_memberships WHERE tenant_id=$1`, [tenantId],
    );
  }

  private async deleteTenantConfiguration(tenantId: string): Promise<void> {
    const sets = `${this.prefix}_tenant_entitlement_sets`;
    await this.transaction(async client => {
      await client.query(
        `DELETE FROM ${this.prefix}_entitlement_resource_items WHERE tenant_id=$1`, [tenantId],
      );
      await client.query(
        `DELETE FROM ${this.prefix}_entitlement_resource_scopes WHERE tenant_id=$1`, [tenantId],
      );
      await client.query(`DELETE FROM ${sets} WHERE tenant_id=$1`, [tenantId]);
      await client.query(`DELETE FROM ${this.prefix}_tenant_policies WHERE tenant_id=$1`, [tenantId]);
      await client.query(`DELETE FROM ${this.prefix}_governance_migration_issues WHERE tenant_id=$1`, [tenantId]);
    });
  }

  private async markAuditRetention(tenantId: string): Promise<void> {
    await this.options.pool.query(
      `UPDATE ${this.prefix}_governance_audit_events
       SET metadata_json=metadata_json || jsonb_build_object('tenantDeletedAt', NOW())
       WHERE target_tenant_id=$1 OR actor_tenant_id=$1`,
      [tenantId],
    );
  }
}
