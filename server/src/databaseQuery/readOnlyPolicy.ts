import { astVisitor, parse, type SelectStatement, type Statement } from 'pgsql-ast-parser';

export type ReadOnlyPolicyCode =
  | 'sql_parse_failed'
  | 'sql_multiple_statements'
  | 'sql_not_read_only'
  | 'sql_locking_forbidden'
  | 'sql_table_not_allowed'
  | 'sql_function_not_allowed';

export class ReadOnlyPolicyError extends Error {
  constructor(readonly code: ReadOnlyPolicyCode) {
    super(code);
    this.name = 'ReadOnlyPolicyError';
  }
}

export interface ReadOnlySqlPolicy {
  allowedSchemas: string[];
  allowedTables: string[];
}

export interface ValidatedReadOnlySql {
  sql: string;
  tables: string[];
}

const DANGEROUS_FUNCTIONS = new Set([
  'dblink',
  'dblink_connect',
  'dblink_exec',
  'lo_export',
  'lo_import',
  'pg_ls_dir',
  'pg_read_binary_file',
  'pg_read_file',
  'pg_sleep',
  'pg_stat_file',
  'set_config',
]);

function normalizeIdentifier(value: string): string {
  return value.trim().toLowerCase();
}

function collectCteNames(value: unknown, names = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectCteNames(item, names);
    return names;
  }
  if (!value || typeof value !== 'object') return names;
  const record = value as Record<string, unknown>;
  if ((record.type === 'with' || record.type === 'with recursive') && Array.isArray(record.bind)) {
    for (const binding of record.bind) {
      if (!binding || typeof binding !== 'object') continue;
      const alias = (binding as { alias?: { name?: unknown } }).alias?.name;
      if (typeof alias === 'string') names.add(normalizeIdentifier(alias));
    }
  }
  for (const child of Object.values(record)) collectCteNames(child, names);
  return names;
}

function assertSelectOnly(statement: Statement): asserts statement is SelectStatement {
  if (statement.type === 'select') return;
  if (statement.type === 'union' || statement.type === 'union all') {
    assertSelectOnly(statement.left);
    assertSelectOnly(statement.right);
    return;
  }
  if (statement.type === 'with') {
    for (const binding of statement.bind) assertSelectOnly(binding.statement);
    assertSelectOnly(statement.in);
    return;
  }
  throw new ReadOnlyPolicyError('sql_not_read_only');
}

export function validateReadOnlySql(sql: string, policy: ReadOnlySqlPolicy): ValidatedReadOnlySql {
  let statements: Statement[];
  try {
    statements = parse(sql);
  } catch {
    throw new ReadOnlyPolicyError('sql_parse_failed');
  }
  if (statements.length !== 1) throw new ReadOnlyPolicyError('sql_multiple_statements');
  const statement = statements[0]!;
  assertSelectOnly(statement);

  const ctes = collectCteNames(statement);
  const tables = new Set<string>();
  const allowedSchemas = new Set(policy.allowedSchemas.map(normalizeIdentifier));
  const allowedTables = new Set(policy.allowedTables.map(normalizeIdentifier));
  const visitor = astVisitor((base) => ({
    selection: (selection) => {
      if (selection.for) throw new ReadOnlyPolicyError('sql_locking_forbidden');
      base.super().selection(selection);
    },
    tableRef: (table) => {
      const tableName = normalizeIdentifier(table.name);
      if (!table.schema && ctes.has(tableName)) return;
      if (!table.schema) throw new ReadOnlyPolicyError('sql_table_not_allowed');
      const schema = normalizeIdentifier(table.schema);
      const qualified = `${schema}.${tableName}`;
      if (
        (allowedSchemas.size > 0 && !allowedSchemas.has(schema)) ||
        (allowedTables.size > 0 && !allowedTables.has(qualified))
      ) {
        throw new ReadOnlyPolicyError('sql_table_not_allowed');
      }
      tables.add(qualified);
      base.super().tableRef(table);
    },
    call: (call) => {
      const name = normalizeIdentifier(call.function.name);
      const qualified = call.function.schema
        ? `${normalizeIdentifier(call.function.schema)}.${name}`
        : name;
      if (
        DANGEROUS_FUNCTIONS.has(name) ||
        name.startsWith('dblink_') ||
        name.startsWith('pg_read_') ||
        name.startsWith('pg_ls_') ||
        qualified.startsWith('pg_catalog.pg_read_')
      ) {
        throw new ReadOnlyPolicyError('sql_function_not_allowed');
      }
      base.super().call(call);
    },
  }));
  visitor.statement(statement);
  return { sql: sql.trim().replace(/;+\s*$/u, ''), tables: [...tables].sort() };
}
