import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import { PgGovernanceMigrationRunner, governanceTablePrefix, type GovernancePgPool } from '../governance-schema/index.js';
import {
  EnvironmentInvariantError,
  type CreateEnvironmentInstanceInput,
  type EnvironmentInstance,
  type EnvironmentInstanceStatus,
  type EnvironmentRecipe,
  type EnvironmentTemplate,
  type EnvironmentTemplateVersion,
  type ExecutionProvider,
  type PublishEnvironmentTemplateInput,
  type RenewEnvironmentInstanceLeaseInput,
  type TransitionEnvironmentInstanceInput,
  type UpsertEnvironmentInstanceInput,
  type UpsertExecutionProviderInput,
} from './types.js';

export interface PgEnvironmentStoreOptions {
  pool: GovernancePgPool;
  tablePrefix?: string;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const FORBIDDEN_RECIPE_KEYS = new Set(['secret', 'secretref', 'token', 'password', 'credential', 'credentialid', 'instanceid', 'sessionid', 'workspaceid']);
const SENSITIVE_COMMAND_PATTERN = /(?:authorization\s*:\s*bearer|bearer\s+[a-z0-9._~-]{8,}|(?:token|secret|password|api[_-]?key)\s*(?:=|:)\s*\S+)/i;
const INSTANCE_TRANSITIONS: Readonly<Record<EnvironmentInstanceStatus, readonly EnvironmentInstanceStatus[]>> = {
  provisioning: ['ready', 'unhealthy', 'draining'],
  ready: ['unhealthy', 'draining'],
  unhealthy: ['ready', 'draining'],
  draining: ['retired'],
  retired: [],
};

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().filter(key => record[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
}

function assertNoSensitiveRecipeFields(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertNoSensitiveRecipeFields);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_RECIPE_KEYS.has(key.toLowerCase())) {
      throw new EnvironmentInvariantError('ENVIRONMENT_RECIPE_SENSITIVE');
    }
    assertNoSensitiveRecipeFields(child);
  }
}

function validateRecipe(recipe: EnvironmentRecipe): void {
  assertNoSensitiveRecipeFields(recipe);
  if (!Array.isArray(recipe.packages)
    || !Array.isArray(recipe.envKeys)
    || !Array.isArray(recipe.setupCommands)
    || recipe.packages.some(item => !item.trim())
    || recipe.envKeys.some(item => !/^[A-Z_][A-Z0-9_]*$/.test(item))
    || recipe.setupCommands.some(command => SENSITIVE_COMMAND_PATTERN.test(command))
    || !recipe.resources
    || typeof recipe.resources !== 'object') {
    throw new EnvironmentInvariantError(
      recipe.setupCommands?.some(command => SENSITIVE_COMMAND_PATTERN.test(command))
        ? 'ENVIRONMENT_RECIPE_SENSITIVE'
        : 'ENVIRONMENT_RECIPE_INVALID',
    );
  }
}

function rowToProvider(row: Record<string, unknown>): ExecutionProvider {
  return {
    providerId: String(row.provider_id),
    status: row.status as ExecutionProvider['status'],
    endpointRef: String(row.endpoint_ref),
    networkPolicy: row.network_policy_json as Record<string, unknown> ?? {},
    ...(row.infrastructure_credential_id ? { infrastructureCredentialId: String(row.infrastructure_credential_id) } : {}),
    rolloutPolicy: row.rollout_policy_json as Record<string, unknown> ?? {},
    revision: Number(row.revision),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    createdBy: String(row.created_by),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    updatedBy: String(row.updated_by),
  };
}

function rowToTemplate(row: Record<string, unknown>): EnvironmentTemplate {
  return {
    templateId: String(row.template_id),
    name: String(row.name),
    status: row.status as EnvironmentTemplate['status'],
    ...(row.current_version_id ? { currentVersionId: String(row.current_version_id) } : {}),
    revision: Number(row.revision),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    createdBy: String(row.created_by),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    updatedBy: String(row.updated_by),
  };
}

function rowToTemplateVersion(row: Record<string, unknown>): EnvironmentTemplateVersion {
  return {
    versionId: String(row.version_id),
    templateId: String(row.template_id),
    versionNumber: Number(row.version_number),
    recipe: row.recipe_json as EnvironmentRecipe,
    digest: String(row.digest),
    publishedAt: row.published_at instanceof Date ? row.published_at.toISOString() : String(row.published_at),
    publishedBy: String(row.published_by),
  };
}

function rowToInstance(row: Record<string, unknown>): EnvironmentInstance {
  return {
    instanceId: String(row.instance_id),
    tenantId: String(row.tenant_id),
    providerId: String(row.provider_id),
    templateId: String(row.template_id),
    templateVersionId: String(row.template_version_id),
    handId: String(row.hand_id),
    status: row.status as EnvironmentInstanceStatus,
    leaseExpiresAt: row.lease_expires_at instanceof Date
      ? row.lease_expires_at.toISOString()
      : String(row.lease_expires_at),
    revision: Number(row.revision),
    recipeDigest: String(row.recipe_digest),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

function validateInstanceIdentity(input: {
  instanceId: string;
  tenantId: string;
  providerId: string;
  templateId: string;
  templateVersionId: string;
  handId: string;
  leaseExpiresAt: string;
}): void {
  if (!ID_PATTERN.test(input.instanceId)
    || !input.tenantId.trim()
    || !input.providerId.trim()
    || !input.templateId.trim()
    || !input.templateVersionId.trim()
    || !input.handId.trim()
    || !input.leaseExpiresAt.trim()
    || Number.isNaN(Date.parse(input.leaseExpiresAt))) {
    throw new EnvironmentInvariantError('ENVIRONMENT_INSTANCE_INVALID');
  }
}

export class PgEnvironmentStore {
  readonly providersTable: string;
  readonly templatesTable: string;
  readonly versionsTable: string;
  readonly instancesTable: string;
  private readonly tablePrefix?: string;

  constructor(private readonly options: PgEnvironmentStoreOptions) {
    const prefix = governanceTablePrefix(options.tablePrefix);
    this.tablePrefix = options.tablePrefix;
    this.providersTable = `${prefix}_execution_providers`;
    this.templatesTable = `${prefix}_environment_templates`;
    this.versionsTable = `${prefix}_environment_template_versions`;
    this.instancesTable = `${prefix}_environment_instances`;
  }

  async init(): Promise<void> {
    await new PgGovernanceMigrationRunner(this.options.pool, this.tablePrefix).run();
  }

  async getProvider(providerId: string): Promise<ExecutionProvider | null> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.providersTable} WHERE provider_id = $1`, [providerId],
    );
    return result.rows[0] ? rowToProvider(result.rows[0]) : null;
  }

  async upsertProvider(input: UpsertExecutionProviderInput): Promise<ExecutionProvider> {
    if (!ID_PATTERN.test(input.providerId) || !input.endpointRef.trim()) {
      throw new EnvironmentInvariantError('EXECUTION_PROVIDER_INVALID');
    }
    return this.withTransaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`provider:${input.providerId}`]);
      const currentResult = await client.query(
        `SELECT * FROM ${this.providersTable} WHERE provider_id = $1 FOR UPDATE`, [input.providerId],
      );
      const current = currentResult.rows[0] ? rowToProvider(currentResult.rows[0]) : null;
      if (!current && input.expectedRevision !== undefined) {
        throw new EnvironmentInvariantError('EXECUTION_PROVIDER_VERSION_CONFLICT');
      }
      if (current && current.revision !== input.expectedRevision) {
        throw new EnvironmentInvariantError('EXECUTION_PROVIDER_VERSION_CONFLICT');
      }
      const result = current
        ? await client.query(`
            UPDATE ${this.providersTable}
            SET status=$2, endpoint_ref=$3, network_policy_json=$4::jsonb,
                infrastructure_credential_id=$5, rollout_policy_json=$6::jsonb,
                revision=revision+1, updated_at=NOW(), updated_by=$7
            WHERE provider_id=$1 AND revision=$8 RETURNING *
          `, [input.providerId, input.status, input.endpointRef, JSON.stringify(input.networkPolicy ?? {}),
            input.infrastructureCredentialId ?? null, JSON.stringify(input.rolloutPolicy ?? {}), input.updatedBy, input.expectedRevision])
        : await client.query(`
            INSERT INTO ${this.providersTable} (
              provider_id,status,endpoint_ref,network_policy_json,infrastructure_credential_id,
              rollout_policy_json,revision,created_by,updated_by
            ) VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb,1,$7,$7) RETURNING *
          `, [input.providerId, input.status, input.endpointRef, JSON.stringify(input.networkPolicy ?? {}),
            input.infrastructureCredentialId ?? null, JSON.stringify(input.rolloutPolicy ?? {}), input.updatedBy]);
      if (!result.rows[0]) throw new EnvironmentInvariantError('EXECUTION_PROVIDER_VERSION_CONFLICT');
      return rowToProvider(result.rows[0]);
    });
  }

  async create(input: CreateEnvironmentInstanceInput): Promise<EnvironmentInstance> {
    const instanceId = input.instanceId ?? randomUUID();
    const normalized = { ...input, instanceId };
    validateInstanceIdentity(normalized);
    return this.withTransaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`environment-instance:${instanceId}`]);
      return this.insertNewInstance(client, normalized, 'provisioning', 'ENVIRONMENT_INSTANCE_ALREADY_EXISTS');
    });
  }

  async createInstance(input: CreateEnvironmentInstanceInput): Promise<EnvironmentInstance> {
    return this.create(input);
  }

  async upsert(input: UpsertEnvironmentInstanceInput): Promise<EnvironmentInstance> {
    validateInstanceIdentity(input);
    return this.withTransaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`environment-instance:${input.instanceId}`]);
      const currentResult = await client.query(
        `SELECT * FROM ${this.instancesTable} WHERE tenant_id=$1 AND instance_id=$2 FOR UPDATE`,
        [input.tenantId, input.instanceId],
      );
      const current = currentResult.rows[0] ? rowToInstance(currentResult.rows[0]) : null;
      if (!current) {
        if (input.expectedRevision !== undefined) {
          throw new EnvironmentInvariantError('ENVIRONMENT_INSTANCE_VERSION_CONFLICT');
        }
        return this.insertNewInstance(client, input, input.status, 'ENVIRONMENT_INSTANCE_ALREADY_EXISTS');
      }
      if (input.expectedRevision === undefined || current.revision !== input.expectedRevision) {
        throw new EnvironmentInvariantError('ENVIRONMENT_INSTANCE_VERSION_CONFLICT');
      }
      if (current.providerId !== input.providerId
        || current.templateId !== input.templateId
        || current.templateVersionId !== input.templateVersionId
        || current.handId !== input.handId) {
        throw new EnvironmentInvariantError('ENVIRONMENT_INSTANCE_INVALID');
      }
      if (input.recipeDigest !== undefined && current.recipeDigest !== input.recipeDigest) {
        throw new EnvironmentInvariantError('ENVIRONMENT_INSTANCE_RECIPE_DIGEST_MISMATCH');
      }
      if (input.status !== current.status && !INSTANCE_TRANSITIONS[current.status].includes(input.status)) {
        throw new EnvironmentInvariantError('ENVIRONMENT_INSTANCE_TRANSITION_INVALID');
      }
      const result = await client.query(`
        UPDATE ${this.instancesTable}
        SET status=$3,lease_expires_at=$4,revision=revision+1,updated_at=NOW()
        WHERE tenant_id=$1 AND instance_id=$2 AND revision=$5 RETURNING *
      `, [input.tenantId, input.instanceId, input.status, input.leaseExpiresAt, input.expectedRevision]);
      if (!result.rows[0]) throw new EnvironmentInvariantError('ENVIRONMENT_INSTANCE_VERSION_CONFLICT');
      return rowToInstance(result.rows[0]);
    });
  }

  async upsertInstance(input: UpsertEnvironmentInstanceInput): Promise<EnvironmentInstance> {
    return this.upsert(input);
  }

  async get(tenantId: string, instanceId: string): Promise<EnvironmentInstance | null> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.instancesTable} WHERE tenant_id=$1 AND instance_id=$2`,
      [tenantId, instanceId],
    );
    return result.rows[0] ? rowToInstance(result.rows[0]) : null;
  }

  async getInstance(tenantId: string, instanceId: string): Promise<EnvironmentInstance | null> {
    return this.get(tenantId, instanceId);
  }

  async listForTenant(tenantId: string): Promise<EnvironmentInstance[]> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.instancesTable} WHERE tenant_id=$1 ORDER BY created_at,instance_id`,
      [tenantId],
    );
    return result.rows.map(rowToInstance);
  }

  async renewLease(input: RenewEnvironmentInstanceLeaseInput): Promise<EnvironmentInstance>;
  async renewLease(
    tenantId: string,
    instanceId: string,
    leaseExpiresAt: string,
    expectedRevision: number,
  ): Promise<EnvironmentInstance>;
  async renewLease(
    inputOrTenantId: RenewEnvironmentInstanceLeaseInput | string,
    instanceId?: string,
    leaseExpiresAt?: string,
    expectedRevision?: number,
  ): Promise<EnvironmentInstance> {
    const input: RenewEnvironmentInstanceLeaseInput = typeof inputOrTenantId === 'string'
      ? { tenantId: inputOrTenantId, instanceId: instanceId ?? '', leaseExpiresAt: leaseExpiresAt ?? '', expectedRevision: expectedRevision ?? -1 }
      : inputOrTenantId;
    if (!input.tenantId.trim() || !input.instanceId.trim() || Number.isNaN(Date.parse(input.leaseExpiresAt))) {
      throw new EnvironmentInvariantError('ENVIRONMENT_INSTANCE_INVALID');
    }
    return this.withTransaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`environment-instance:${input.instanceId}`]);
      const currentResult = await client.query(
        `SELECT * FROM ${this.instancesTable} WHERE tenant_id=$1 AND instance_id=$2 FOR UPDATE`,
        [input.tenantId, input.instanceId],
      );
      if (!currentResult.rows[0]) throw new EnvironmentInvariantError('ENVIRONMENT_INSTANCE_NOT_FOUND');
      const current = rowToInstance(currentResult.rows[0]);
      if (current.revision !== input.expectedRevision) {
        throw new EnvironmentInvariantError('ENVIRONMENT_INSTANCE_VERSION_CONFLICT');
      }
      if (current.status === 'retired') {
        throw new EnvironmentInvariantError('ENVIRONMENT_INSTANCE_TRANSITION_INVALID');
      }
      const result = await client.query(`
        UPDATE ${this.instancesTable}
        SET lease_expires_at=$3,revision=revision+1,updated_at=NOW()
        WHERE tenant_id=$1 AND instance_id=$2 AND revision=$4 RETURNING *
      `, [input.tenantId, input.instanceId, input.leaseExpiresAt, input.expectedRevision]);
      if (!result.rows[0]) throw new EnvironmentInvariantError('ENVIRONMENT_INSTANCE_VERSION_CONFLICT');
      return rowToInstance(result.rows[0]);
    });
  }

  async transition(input: TransitionEnvironmentInstanceInput): Promise<EnvironmentInstance>;
  async transition(
    tenantId: string,
    instanceId: string,
    status: EnvironmentInstanceStatus,
    expectedRevision: number,
  ): Promise<EnvironmentInstance>;
  async transition(
    inputOrTenantId: TransitionEnvironmentInstanceInput | string,
    instanceId?: string,
    status?: EnvironmentInstanceStatus,
    expectedRevision?: number,
  ): Promise<EnvironmentInstance> {
    const input: TransitionEnvironmentInstanceInput = typeof inputOrTenantId === 'string'
      ? { tenantId: inputOrTenantId, instanceId: instanceId ?? '', status: status ?? 'provisioning', expectedRevision: expectedRevision ?? -1 }
      : inputOrTenantId;
    return this.withTransaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`environment-instance:${input.instanceId}`]);
      const currentResult = await client.query(
        `SELECT * FROM ${this.instancesTable} WHERE tenant_id=$1 AND instance_id=$2 FOR UPDATE`,
        [input.tenantId, input.instanceId],
      );
      if (!currentResult.rows[0]) throw new EnvironmentInvariantError('ENVIRONMENT_INSTANCE_NOT_FOUND');
      const current = rowToInstance(currentResult.rows[0]);
      if (current.revision !== input.expectedRevision) {
        throw new EnvironmentInvariantError('ENVIRONMENT_INSTANCE_VERSION_CONFLICT');
      }
      if (!INSTANCE_TRANSITIONS[current.status].includes(input.status)) {
        throw new EnvironmentInvariantError('ENVIRONMENT_INSTANCE_TRANSITION_INVALID');
      }
      const result = await client.query(`
        UPDATE ${this.instancesTable}
        SET status=$3,revision=revision+1,updated_at=NOW()
        WHERE tenant_id=$1 AND instance_id=$2 AND revision=$4 RETURNING *
      `, [input.tenantId, input.instanceId, input.status, input.expectedRevision]);
      if (!result.rows[0]) throw new EnvironmentInvariantError('ENVIRONMENT_INSTANCE_VERSION_CONFLICT');
      return rowToInstance(result.rows[0]);
    });
  }

  async transitionInstance(input: TransitionEnvironmentInstanceInput): Promise<EnvironmentInstance> {
    return this.transition(input);
  }

  async getTemplate(templateId: string): Promise<EnvironmentTemplate | null> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.templatesTable} WHERE template_id = $1`, [templateId],
    );
    return result.rows[0] ? rowToTemplate(result.rows[0]) : null;
  }

  async getTemplateVersion(versionId: string): Promise<EnvironmentTemplateVersion | null> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.versionsTable} WHERE version_id = $1`, [versionId],
    );
    return result.rows[0] ? rowToTemplateVersion(result.rows[0]) : null;
  }

  async publishTemplate(input: PublishEnvironmentTemplateInput): Promise<{
    template: EnvironmentTemplate;
    publishedVersion: EnvironmentTemplateVersion;
    created: boolean;
  }> {
    if (!ID_PATTERN.test(input.templateId) || !input.name.trim()) {
      throw new EnvironmentInvariantError('ENVIRONMENT_RECIPE_INVALID');
    }
    validateRecipe(input.recipe);
    const digest = createHash('sha256').update(canonicalize(input.recipe)).digest('hex');
    return this.withTransaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`environment-template:${input.templateId}`]);
      const currentResult = await client.query(
        `SELECT * FROM ${this.templatesTable} WHERE template_id = $1 FOR UPDATE`, [input.templateId],
      );
      const current = currentResult.rows[0] ? rowToTemplate(currentResult.rows[0]) : null;
      if (current?.status === 'retired') throw new EnvironmentInvariantError('ENVIRONMENT_TEMPLATE_RETIRED');
      if (!current) {
        await client.query(`
          INSERT INTO ${this.templatesTable} (template_id,name,status,revision,created_by,updated_by)
          VALUES ($1,$2,'draft',1,$3,$3)
        `, [input.templateId, input.name, input.publishedBy]);
      }
      const duplicate = await client.query(
        `SELECT * FROM ${this.versionsTable} WHERE template_id=$1 AND digest=$2`, [input.templateId, digest],
      );
      if (duplicate.rows[0]) {
        const template = await client.query(`SELECT * FROM ${this.templatesTable} WHERE template_id=$1`, [input.templateId]);
        return { template: rowToTemplate(template.rows[0]), publishedVersion: rowToTemplateVersion(duplicate.rows[0]), created: false };
      }
      const next = await client.query(
        `SELECT COALESCE(MAX(version_number),0)::bigint+1 AS next_version FROM ${this.versionsTable} WHERE template_id=$1`,
        [input.templateId],
      );
      const versionId = randomUUID();
      const version = await client.query(`
        INSERT INTO ${this.versionsTable} (version_id,template_id,version_number,recipe_json,digest,published_by)
        VALUES ($1,$2,$3,$4::jsonb,$5,$6) RETURNING *
      `, [versionId, input.templateId, Number(next.rows[0]?.next_version ?? 1), JSON.stringify(input.recipe), digest, input.publishedBy]);
      const template = await client.query(`
        UPDATE ${this.templatesTable}
        SET name=$2,status='published',current_version_id=$3,revision=revision+1,updated_at=NOW(),updated_by=$4
        WHERE template_id=$1 RETURNING *
      `, [input.templateId, input.name, versionId, input.publishedBy]);
      return { template: rowToTemplate(template.rows[0]), publishedVersion: rowToTemplateVersion(version.rows[0]), created: true };
    });
  }

  async retireTemplate(templateId: string, expectedRevision: number, updatedBy: string): Promise<EnvironmentTemplate> {
    return this.withTransaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`environment-template:${templateId}`]);
      const currentResult = await client.query(
        `SELECT * FROM ${this.templatesTable} WHERE template_id=$1 FOR UPDATE`, [templateId],
      );
      if (!currentResult.rows[0]) throw new EnvironmentInvariantError('ENVIRONMENT_TEMPLATE_NOT_FOUND');
      const current = rowToTemplate(currentResult.rows[0]);
      if (current.status === 'retired') throw new EnvironmentInvariantError('ENVIRONMENT_TEMPLATE_RETIRED');
      if (current.revision !== expectedRevision) throw new EnvironmentInvariantError('ENVIRONMENT_TEMPLATE_VERSION_CONFLICT');
      const result = await client.query(`
        UPDATE ${this.templatesTable}
        SET status='retired',revision=revision+1,updated_at=NOW(),updated_by=$2
        WHERE template_id=$1 AND revision=$3 RETURNING *
      `, [templateId, updatedBy, expectedRevision]);
      if (!result.rows[0]) throw new EnvironmentInvariantError('ENVIRONMENT_TEMPLATE_VERSION_CONFLICT');
      return rowToTemplate(result.rows[0]);
    });
  }

  private async insertNewInstance(
    client: PoolClient,
    input: {
      instanceId: string;
      tenantId: string;
      providerId: string;
      templateId: string;
      templateVersionId: string;
      handId: string;
      leaseExpiresAt: string;
      recipeDigest?: string;
    },
    status: EnvironmentInstanceStatus,
    duplicateCode: 'ENVIRONMENT_INSTANCE_ALREADY_EXISTS',
  ): Promise<EnvironmentInstance> {
    if (!Object.prototype.hasOwnProperty.call(INSTANCE_TRANSITIONS, status)) {
      throw new EnvironmentInvariantError('ENVIRONMENT_INSTANCE_INVALID');
    }
    const providerResult = await client.query(
      `SELECT status FROM ${this.providersTable} WHERE provider_id = $1 FOR SHARE`,
      [input.providerId],
    );
    if (!providerResult.rows[0] || providerResult.rows[0].status !== 'enabled') {
      throw new EnvironmentInvariantError('ENVIRONMENT_INSTANCE_PROVIDER_UNAVAILABLE');
    }
    const versionResult = await client.query(`
      SELECT v.digest
      FROM ${this.versionsTable} v
      INNER JOIN ${this.templatesTable} t ON t.template_id=v.template_id
      WHERE v.version_id=$1 AND v.template_id=$2 AND t.status='published'
      FOR SHARE
    `, [input.templateVersionId, input.templateId]);
    if (!versionResult.rows[0]) {
      throw new EnvironmentInvariantError('ENVIRONMENT_INSTANCE_TEMPLATE_VERSION_INVALID');
    }
    const recipeDigest = String(versionResult.rows[0].digest);
    if (input.recipeDigest !== undefined && input.recipeDigest !== recipeDigest) {
      throw new EnvironmentInvariantError('ENVIRONMENT_INSTANCE_RECIPE_DIGEST_MISMATCH');
    }
    const result = await client.query(`
      INSERT INTO ${this.instancesTable} (
        instance_id,tenant_id,provider_id,template_id,template_version_id,hand_id,
        status,lease_expires_at,revision,recipe_digest
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9)
      ON CONFLICT DO NOTHING
      RETURNING *
    `, [input.instanceId, input.tenantId, input.providerId, input.templateId, input.templateVersionId,
      input.handId, status, input.leaseExpiresAt, recipeDigest]);
    if (!result.rows[0]) throw new EnvironmentInvariantError(duplicateCode);
    return rowToInstance(result.rows[0]);
  }

  private async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export { assertNoSensitiveRecipeFields };
