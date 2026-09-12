import { describe, expect, it } from 'vitest';

import {
  resolveSubagentExecutionOptions,
  SubagentExecutionOptionsError,
} from '../runtime/subagent/subagentExecutionOptions.js';
import {
  formatSubagentModelCatalog,
  projectSubagentModelCatalog,
} from '../runtime/subagent/subagentModelCatalog.js';

const resolvedModel = {
  model: 'provider-model',
  connection: { apiKey: 'secret', baseUrl: 'https://provider.example/v1' },
  providerOptions: {
    reasoningEffortCapability: {
      support: 'supported' as const,
      values: ['low', 'medium', 'high'],
      defaultValue: 'medium',
      source: 'configured' as const,
    },
    extraBody: { temperature: 0.2 },
  },
};

describe('resolveSubagentExecutionOptions', () => {
  it('keeps a fixed policy authoritative and rejects an explicit conflict', () => {
    expect(() =>
      resolveSubagentExecutionOptions({
        requestedModelRef: 'other/model',
        profileModel: { strategy: 'fixed', modelRef: 'locked/model' },
        modelResolver: () => resolvedModel,
      }),
    ).toThrowError(
      new SubagentExecutionOptionsError(
        'MODEL_POLICY_CONFLICT',
        '显式 model other/model 与锁定模型 locked/model 冲突，不会静默覆盖。',
      ),
    );
  });

  it('rejects two independent fixed policies that disagree', () => {
    expect(() =>
      resolveSubagentExecutionOptions({
        profileModel: { strategy: 'fixed', modelRef: 'profile/model' },
        workerModel: { strategy: 'fixed', modelRef: 'worker/model' },
        modelResolver: () => resolvedModel,
      }),
    ).toThrow('子 agent 模型锁定策略冲突');
  });

  it('passes the tenant to the resolver and clones provider options per run', () => {
    let receivedTenant: string | undefined;
    const result = resolveSubagentExecutionOptions({
      requestedModelRef: 'group/model',
      requestedEffort: 'high',
      tenantId: 'tenant-a',
      modelResolver: (ref, tenantId) => {
        expect(ref).toBe('group/model');
        receivedTenant = tenantId;
        return resolvedModel;
      },
    });

    expect(receivedTenant).toBe('tenant-a');
    expect(result).toMatchObject({
      resolvedModelRef: 'group/model',
      model: 'provider-model',
      modelSource: 'explicit',
      modelLocked: false,
      resolvedEffort: 'high',
      effortSource: 'explicit',
      providerOptions: { reasoningEffort: 'high' },
    });
    expect(result.providerOptions).not.toBe(resolvedModel.providerOptions);
    expect(result.providerOptions?.extraBody).not.toBe(resolvedModel.providerOptions.extraBody);
  });

  it('uses the capability default for a new run when no effort is requested', () => {
    const result = resolveSubagentExecutionOptions({
      inheritedModelRef: 'group/model',
      modelResolver: () => resolvedModel,
    });

    expect(result.resolvedEffort).toBe('medium');
    expect(result.effortSource).toBe('capability_default');
    expect(result.providerOptions?.reasoningEffort).toBe('medium');
  });

  it('切换模型时不继承旧模型 effort，改用目标模型默认值', () => {
    const result = resolveSubagentExecutionOptions({
      requestedModelRef: 'group/new-model',
      inheritedModelRef: 'group/old-model',
      inheritedEffort: 'high',
      modelResolver: () => resolvedModel,
    });
    expect(result.resolvedEffort).toBe('medium');
    expect(result.effortSource).toBe('capability_default');
  });

  it('rejects explicit effort without verified values instead of guessing', () => {
    expect(() =>
      resolveSubagentExecutionOptions({
        requestedEffort: 'high',
        requestedModelRef: 'group/model',
        modelResolver: () => ({ model: 'provider-model', providerOptions: {} }),
      }),
    ).toThrow('没有已验证的 reasoning effort 值目录');
  });

  it('rejects an effort outside the configured model values', () => {
    expect(() =>
      resolveSubagentExecutionOptions({
        requestedEffort: 'xhigh',
        requestedModelRef: 'group/model',
        modelResolver: () => resolvedModel,
      }),
    ).toThrow('不接受 reasoning effort=xhigh');
  });

  it('fails closed when a tenant model ref is unavailable', () => {
    expect(() =>
      resolveSubagentExecutionOptions({
        inheritedModelRef: 'removed/model',
        tenantId: 'tenant-a',
        modelResolver: () => null,
      }),
    ).toThrow('不在当前组织可用模型白名单内');
  });
});

describe('subagent model catalog', () => {
  const catalog = {
    defaultRef: 'group/a',
    models: [
      {
        ref: 'group/a',
        name: '模型 A',
        effort: {
          support: 'supported' as const,
          values: ['low', 'high'],
          defaultValue: 'low',
          source: 'configured' as const,
        },
      },
      {
        ref: 'group/b',
        name: '模型 B',
        description: '长任务',
        effort: { support: 'unknown' as const },
      },
    ],
  };

  it('目录和执行共用 fixed/default 解析规则', () => {
    const fixed = projectSubagentModelCatalog({
      catalog,
      workerModel: { strategy: 'fixed', modelRef: 'group/b' },
    });
    expect(fixed.map((model) => model.ref)).toEqual(['group/b']);
    expect(fixed[0]).toMatchObject({ default: true, locked: true });

    const overridable = projectSubagentModelCatalog({
      catalog,
      profileModel: { strategy: 'default', modelRef: 'group/b' },
    });
    expect(overridable.map((model) => model.ref)).toEqual(['group/a', 'group/b']);
    expect(overridable.find((model) => model.default)?.ref).toBe('group/b');
  });

  it('只格式化脱敏字段和可信 effort 值', () => {
    const text = formatSubagentModelCatalog(projectSubagentModelCatalog({ catalog }));
    expect(text).toContain('group/a：模型 A');
    expect(text).toContain('effort=low|high（默认 low）');
    expect(text).toContain('group/b：模型 B，长任务');
    expect(text).not.toContain('apiKey');
    expect(text).not.toContain('baseUrl');
  });
});
