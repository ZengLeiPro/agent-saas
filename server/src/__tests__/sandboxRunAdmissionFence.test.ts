import { describe, expect, it } from 'vitest';

import { sandboxRunAdmissionFenceSql } from '../runtime/sandboxRunAdmissionFence.js';

describe('sandbox Run admission fence SQL', () => {
  const sql = sandboxRunAdmissionFenceSql('runtime_runs').join('\n');

  it('rechecks active metadata-only transitions such as staged to ready', () => {
    expect(sql).not.toContain('NEW.status IS NOT DISTINCT FROM OLD.status');
    expect(sql).toContain('BEFORE INSERT OR UPDATE OF status, session_id, tenant_id, sandbox_scope_id, metadata');
  });

  it('ignores the cleanup carrier itself but fail-closes legacy null tenants', () => {
    expect(sql).toContain('cleanup.run_id<>NEW.run_id');
    expect(sql).toContain('NEW.tenant_id IS NULL OR cleanup.tenant_id IS NULL OR cleanup.tenant_id=NEW.tenant_id');
  });
});
