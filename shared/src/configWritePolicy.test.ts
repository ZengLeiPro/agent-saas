import { describe, expect, it } from 'vitest';
import {
  getConfigWritePolicy,
  parseConfigWritePolicy,
  PRODUCTION_CONFIG_PUBLISH_REQUIRED,
} from './configWritePolicy';

describe('config write capability contract', () => {
  it.each(['staging', 'development', 'test'] as const)(
    '%s permits the existing online path',
    (environment) => {
      expect(getConfigWritePolicy(environment)).toEqual({
        environment,
        mode: 'online',
        canSave: true,
      });
    },
  );
  it('production defaults to the same fail-closed policy as mutate', () => {
    const policy = getConfigWritePolicy('production');
    expect(policy).toMatchObject({
      environment: 'production',
      canSave: false,
      reasonCode: PRODUCTION_CONFIG_PUBLISH_REQUIRED,
    });
    expect(parseConfigWritePolicy(policy)).toEqual(policy);
  });
  it('retains the existing INTERNAL controlled-publisher option', () => {
    expect(getConfigWritePolicy('production', true)).toEqual({
      environment: 'production',
      mode: 'online',
      canSave: true,
    });
  });
  it.each([
    undefined,
    null,
    [],
    {},
    true,
    { environment: 'unknown', mode: 'online', canSave: true },
    { environment: 'production', mode: 'online', canSave: 'true' },
    { environment: 'production', mode: 'online', canSave: false },
    {
      environment: 'production',
      mode: 'online',
      canSave: true,
      reasonCode: PRODUCTION_CONFIG_PUBLISH_REQUIRED,
    },
    { environment: 'production', mode: 'controlled-publish-required', canSave: true },
    { environment: 'production', mode: 'controlled-publish-required', canSave: false },
    { ...getConfigWritePolicy('production'), environment: 'staging' },
    { ...getConfigWritePolicy('production'), message: '' },
    { ...getConfigWritePolicy('production'), message: '  ' },
  ])('does not interpret malformed metadata as write permission: %j', (input) => {
    expect(parseConfigWritePolicy(input)).toBeNull();
  });
  it('round trips a supported online capability', () => {
    const policy = getConfigWritePolicy('staging');
    expect(parseConfigWritePolicy(policy)).toEqual(policy);
  });
});
