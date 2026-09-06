/**
 * 治理迁移执行器。从 `migrations.ts` 外提（该文件已逼近 1000 行的生产阈值），
 * 语义与外提前逐字一致：advisory lock 串行、按**已应用版本集合**判定，
 * 因此版本号序列允许有空洞（并行 WP 各占一个号，合并后自动补齐）。
 */
import { governanceTablePrefix } from './governanceTablePrefix.js';
import { governanceMigrationStatements, type GovernancePgPool } from './migrations.js';

export class PgGovernanceMigrationRunner {
  readonly schemaVersionsTable: string;
  readonly prefix: string;

  constructor(
    private readonly pool: GovernancePgPool,
    tablePrefix?: string,
  ) {
    this.prefix = governanceTablePrefix(tablePrefix);
    this.schemaVersionsTable = `${this.prefix}_governance_schema_versions`;
  }

  async run(targetVersion = Number.POSITIVE_INFINITY): Promise<void> {
    const client = await this.pool.connect();
    const lockKey = `${this.schemaVersionsTable}:migrate`;
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.schemaVersionsTable} (
          version INTEGER PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      const appliedResult = await client.query<{ version: number }>(
        `SELECT version FROM ${this.schemaVersionsTable} ORDER BY version`,
      );
      const applied = new Set(appliedResult.rows.map((row) => Number(row.version)));

      for (const migration of governanceMigrationStatements(this.prefix)) {
        if (migration.version > targetVersion || applied.has(migration.version)) continue;
        await client.query('BEGIN');
        try {
          for (const statement of migration.statements) {
            await client.query(statement);
          }
          await client.query(`INSERT INTO ${this.schemaVersionsTable} (version) VALUES ($1)`, [
            migration.version,
          ]);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        }
      }
    } finally {
      await client
        .query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey])
        .catch(() => undefined);
      client.release();
    }
  }
}
