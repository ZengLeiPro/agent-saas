import { describe, expect, it } from 'vitest';

import {
  DEFAULT_EXECUTION_CONFIG,
  createExecutionConfig,
  resolveExecutionTarget,
} from '../runtime/executionConfig.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';

describe('executionConfig.createExecutionConfig', () => {
  it('defaults to anonymous server-local + authenticated server-container + admin override allowed, user override forbidden', () => {
    const cfg = createExecutionConfig();
    expect(cfg.defaultTarget).toBe('server-local');
    expect(cfg.tenantDefaultTarget).toBe('server-container');
    expect(cfg.allowAdminOverride).toBe(true);
    expect(cfg.allowUserOverride).toBe(false);
  });

  it('exposes a frozen DEFAULT_EXECUTION_CONFIG so callers cannot mutate the shared default', () => {
    expect(Object.isFrozen(DEFAULT_EXECUTION_CONFIG)).toBe(true);
    expect(DEFAULT_EXECUTION_CONFIG.defaultTarget).toBe('server-local');
    expect(DEFAULT_EXECUTION_CONFIG.tenantDefaultTarget).toBe('server-container');
  });

  it('respects partial overrides', () => {
    const cfg = createExecutionConfig({ defaultTarget: 'server-container', tenantDefaultTarget: 'server-remote', allowAdminOverride: false });
    expect(cfg.defaultTarget).toBe('server-container');
    expect(cfg.tenantDefaultTarget).toBe('server-remote');
    expect(cfg.allowAdminOverride).toBe(false);
    expect(cfg.allowUserOverride).toBe(false);
  });
});

describe('executionConfig.resolveExecutionTarget', () => {
  const baseConfig = DEFAULT_EXECUTION_CONFIG;

  it('falls back to anonymous defaultTarget when no requested target/user is provided', () => {
    const decision = resolveExecutionTarget({ config: baseConfig });
    expect(decision).toEqual({ ok: true, target: 'server-local', source: 'config_default' });
  });

  it('defaults platform admin to server-container when no requested target is provided', () => {
    const decision = resolveExecutionTarget({
      user: { role: 'admin', tenantId: DEFAULT_TENANT_ID },
      config: baseConfig,
    });
    expect(decision).toEqual({ ok: true, target: 'server-container', source: 'config_default' });
  });

  it('defaults tenant admin and regular users to tenantDefaultTarget when no requested target is provided', () => {
    expect(resolveExecutionTarget({
      user: { role: 'admin', tenantId: 'wain-test' },
      config: baseConfig,
    })).toEqual({ ok: true, target: 'server-container', source: 'config_default' });
    expect(resolveExecutionTarget({
      user: { role: 'user', tenantId: 'wain-test' },
      config: baseConfig,
    })).toEqual({ ok: true, target: 'server-container', source: 'config_default' });
  });

  it('treats empty string as missing requested target', () => {
    const decision = resolveExecutionTarget({ requested: '', user: { role: 'user', tenantId: 'wain-test' }, config: baseConfig });
    expect(decision).toEqual({ ok: true, target: 'server-container', source: 'config_default' });
  });

  it('allows admin to override to server-container', () => {
    const decision = resolveExecutionTarget({
      requested: 'server-container',
      user: { role: 'admin', tenantId: DEFAULT_TENANT_ID },
      config: baseConfig,
    });
    expect(decision).toEqual({ ok: true, target: 'server-container', source: 'admin_override' });
  });

  it('allows admin to explicitly select the default target', () => {
    const decision = resolveExecutionTarget({
      requested: 'server-local',
      user: { role: 'admin', tenantId: DEFAULT_TENANT_ID },
      config: baseConfig,
    });
    expect(decision).toEqual({ ok: true, target: 'server-local', source: 'admin_override' });
  });

  it('rejects non-admin user when allowUserOverride is false (current default)', () => {
    const decision = resolveExecutionTarget({
      requested: 'server-container',
      user: { role: 'user' },
      config: baseConfig,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.kind).toBe('override_not_allowed');
      expect(decision.reason).toBe('无权选择 executionTarget');
    }
  });

  it('rejects anonymous client (no user) requesting an override', () => {
    const decision = resolveExecutionTarget({
      requested: 'server-container',
      config: baseConfig,
    });
    expect(decision.ok).toBe(false);
  });

  it('rejects admin override when allowAdminOverride is disabled', () => {
    const cfg = createExecutionConfig({ allowAdminOverride: false });
    const decision = resolveExecutionTarget({
      requested: 'server-container',
      user: { role: 'admin', tenantId: DEFAULT_TENANT_ID },
      config: cfg,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.kind).toBe('override_not_allowed');
  });

  it('allows non-admin user override when allowUserOverride is enabled', () => {
    const cfg = createExecutionConfig({ allowUserOverride: true });
    const decision = resolveExecutionTarget({
      requested: 'server-container',
      user: { role: 'user' },
      config: cfg,
    });
    expect(decision).toEqual({ ok: true, target: 'server-container', source: 'admin_override' });
  });

  it('rejects unknown target strings before checking override permission', () => {
    const decision = resolveExecutionTarget({
      requested: 'remote-ecs',
      user: { role: 'admin', tenantId: DEFAULT_TENANT_ID },
      config: baseConfig,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.kind).toBe('unknown_target');
      expect(decision.reason).toContain('remote-ecs');
    }
  });

  it('rejects the legacy "client" target until a provider is registered', () => {
    // ExecutionTargetKind 中保留了 'client'，但默认 registry 不注册它，
    // 任何通道都不应误开放。这条防御性测试锁定行为。
    const decision = resolveExecutionTarget({
      requested: 'client',
      user: { role: 'admin', tenantId: DEFAULT_TENANT_ID },
      config: baseConfig,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.kind).toBe('unknown_target');
  });

  it('honors custom platform and tenant defaults when no requested target is provided', () => {
    const cfg = createExecutionConfig({ defaultTarget: 'server-remote', tenantDefaultTarget: 'server-container' });
    expect(resolveExecutionTarget({ config: cfg })).toEqual({ ok: true, target: 'server-remote', source: 'config_default' });
    expect(resolveExecutionTarget({ user: { role: 'admin', tenantId: DEFAULT_TENANT_ID }, config: cfg })).toEqual({ ok: true, target: 'server-container', source: 'config_default' });
    expect(resolveExecutionTarget({ user: { role: 'user', tenantId: 'wain-test' }, config: cfg })).toEqual({ ok: true, target: 'server-container', source: 'config_default' });
  });
});
