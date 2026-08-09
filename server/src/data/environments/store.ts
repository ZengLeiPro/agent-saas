import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import { PgGovernanceMigrationRunner, governanceTablePrefix, type GovernancePgPool } from '../governance-schema/index.js';
import {
  EnvironmentInvariantError,
  type EnvironmentRecipe,
  type EnvironmentTemplate,
  type EnvironmentTemplateVersion,
  type ExecutionProvider,
  type PublishEnvironmentTemplateInput,
  type UpsertExecutionProviderInput,
} from './types.js';

export interface PgEnvironmentStoreOptions {
  pool: GovernancePgPool;
  tablePrefix?: string;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const FORBIDDEN_RECIPE_KEYS = new Set(['secret', 'secretref', 'token', 'password', 'credential', 'credentialid', 'instanceid', 'sessionid', 'workspaceid']);
const SENSITIVE_COMMAND_PATTERN = /(?:token|secret|password|api[_-]?key)\s*=/i;

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

export class PgEnvironmentStore {
  readonly providersTable: string;
  readonly templatesTable: string;
  readonly versionsTable: string;
  private readonly tablePrefix?: string;

  constructor(private readonly options: PgEnvironmentStoreOptions) {
    const prefix = governanceTablePrefix(options.tablePrefix);
    this.tablePrefix = options.tablePrefix;
    this.providersTable = `${prefix}_execution_providers`;
    this.templatesTable = `${prefix}_environment_templates`;
    this.versionsTable = `${prefix}_environment_template_versions`;
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
