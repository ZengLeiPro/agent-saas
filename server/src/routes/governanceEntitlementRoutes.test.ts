import { describe, expect, it } from 'vitest';

import { containsNewCatalogMissingResource } from './governanceEntitlementRoutes.js';

describe('Entitlement scope 旧目录资源校验', () => {
  it('允许保留或移除旧基线 ID', () => {
    expect(
      containsNewCatalogMissingResource(
        ['catalog-skill', 'retired-skill'],
        ['catalog-skill', 'retired-skill'],
        ['catalog-skill'],
      ),
    ).toBe(false);
    expect(
      containsNewCatalogMissingResource(
        ['catalog-skill'],
        ['catalog-skill', 'retired-skill'],
        ['catalog-skill'],
      ),
    ).toBe(false);
  });

  it('拒绝把目录外 ID 作为新授权加入', () => {
    expect(
      containsNewCatalogMissingResource(
        ['catalog-skill', 'new-retired-skill'],
        ['catalog-skill'],
        ['catalog-skill'],
      ),
    ).toBe(true);
  });
});
