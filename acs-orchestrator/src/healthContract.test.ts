import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { lifecyclePolicyHealth } from './config.js';

describe('ACS health and drain contract', () => {
  it('exposes the effective lifecycle policy mode', () => {
    expect(lifecyclePolicyHealth({ lifecyclePolicyMode: 'enforce' })).toEqual({
      lifecyclePolicyMode: 'enforce',
    });
    expect(lifecyclePolicyHealth({ lifecyclePolicyMode: 'shadow' })).toEqual({
      lifecyclePolicyMode: 'shadow',
    });
    expect(lifecyclePolicyHealth({})).toEqual({ lifecyclePolicyMode: 'shadow' });
  });

  it('includes lifecycle policy mode in the /health payload', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/\.\.\.lifecyclePolicyHealth\(config\)/u);
  });

  it('advertises the organization task shared read-only mount protocol', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
    expect(source).toContain('sharedReadOnlyMount: {');
    expect(source).toContain('protocolVersion: 1');
  });

  it('uses HTTP plus background recovery as effective inflight for health, SNAT, and drain', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8');
    expect(source).toContain(
      'const effectiveInflightRequests = () => inflightRequests + executor.backgroundRecoveryCount()',
    );
    expect(source).toContain('inflightRequests: effectiveInflightRequests');
    expect(source).toContain('inflight: effectiveInflightRequests()');
    expect(source).toContain('if (effectiveInflightRequests() === 0)');
  });
});
