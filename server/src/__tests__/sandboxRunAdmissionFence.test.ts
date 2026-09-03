import { describe, expect, it } from 'vitest';

import { sandboxRunAdmissionFenceSql } from '../runtime/sandboxRunAdmissionFence.js';

describe('sandbox Run admission fence SQL', () => {
  const sql = sandboxRunAdmissionFenceSql('runtime_runs').join('\n');

  it('rechecks active metadata-only transitions such as staged to ready', () => {
    expect(sql).not.toContain('NEW.status IS NOT DISTINCT FROM OLD.status');
    expect(sql).toContain('BEFORE INSERT OR UPDATE OF status, session_id, tenant_id, sandbox_scope_id, metadata');
  });

  it('ignores the cleanup carrier itself and isolates legacy null rows to kaiyan', () => {
    expect(sql).toContain('cleanup.run_id<>NEW.run_id');
    expect(sql).toContain("COALESCE(cleanup.tenant_id, 'kaiyan')=COALESCE(NEW.tenant_id, 'kaiyan')");
    expect(sql).toContain("COALESCE(candidate.tenant_id, 'kaiyan')=COALESCE(NEW.tenant_id, 'kaiyan')");
  });
});
