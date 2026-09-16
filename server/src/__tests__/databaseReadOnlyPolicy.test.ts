import { describe, expect, it } from 'vitest';

import { ReadOnlyPolicyError, validateReadOnlySql } from '../databaseQuery/readOnlyPolicy.js';

const policy = {
  allowedSchemas: ['reporting'],
  allowedTables: ['reporting.orders', 'reporting.customers'],
};

function rejected(sql: string, code: ReadOnlyPolicyError['code']): void {
  try {
    validateReadOnlySql(sql, policy);
    throw new Error('expected query to be rejected');
  } catch (error) {
    expect(error).toBeInstanceOf(ReadOnlyPolicyError);
    expect((error as ReadOnlyPolicyError).code).toBe(code);
  }
}

describe('external database read-only SQL policy', () => {
  it('accepts a single qualified SELECT and a read-only CTE', () => {
    expect(
      validateReadOnlySql(
        'SELECT o.id FROM reporting.orders o JOIN reporting.customers c ON c.id=o.customer_id;',
        policy,
      ),
    ).toMatchObject({ tables: ['reporting.customers', 'reporting.orders'] });
    expect(
      validateReadOnlySql(
        'WITH recent AS (SELECT id FROM reporting.orders) SELECT id FROM recent',
        policy,
      ).tables,
    ).toEqual(['reporting.orders']);
  });

  it('rejects writes, multiple statements, row locks and unqualified tables', () => {
    rejected('UPDATE reporting.orders SET total=0', 'sql_not_read_only');
    rejected('SELECT 1; SELECT 2', 'sql_multiple_statements');
    rejected('SELECT * FROM reporting.orders FOR UPDATE', 'sql_locking_forbidden');
    rejected('SELECT * FROM orders', 'sql_table_not_allowed');
  });

  it('rejects non-allowlisted objects, dangerous functions and writable CTEs', () => {
    rejected('SELECT * FROM private.payroll', 'sql_table_not_allowed');
    rejected("SELECT pg_read_file('/etc/passwd')", 'sql_function_not_allowed');
    rejected(
      'WITH changed AS (DELETE FROM reporting.orders RETURNING id) SELECT * FROM changed',
      'sql_not_read_only',
    );
  });
});
