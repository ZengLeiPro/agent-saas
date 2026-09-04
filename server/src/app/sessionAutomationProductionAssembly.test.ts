import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ModelGoalEvaluator, SessionAutomationEvaluator } from '../runtime/sessionAutomationEvaluator.js';
import { SessionAutomationCoordinator } from '../runtime/sessionAutomationCoordinator.js';
import { SessionAutomationRuntimeGuard } from '../runtime/sessionAutomationRuntimeGuard.js';

type Assert<T extends true> = T;
type IsRequired<T, K extends keyof T> = {} extends Pick<T, K> ? false : true;
type ModelGoalEvaluatorOptions = ConstructorParameters<typeof ModelGoalEvaluator>[0];
const compileTimeLiveGateContract: [
  Assert<ConstructorParameters<typeof SessionAutomationRuntimeGuard> extends [unknown, () => boolean, ...unknown[]] ? true : false>,
  Assert<ConstructorParameters<typeof SessionAutomationEvaluator> extends [unknown, unknown, () => boolean] ? true : false>,
  Assert<ConstructorParameters<typeof SessionAutomationCoordinator> extends [unknown, unknown, { executionEnabled: () => boolean }] ? true : false>,
  Assert<IsRequired<ModelGoalEvaluatorOptions, 'runtimeGuard'>>,
  Assert<IsRequired<ModelGoalEvaluatorOptions, 'executionEnabled'>>,
] = [true, true, true, true, true];

describe('Session Automation production assembly', () => {
  it('keeps every live gate dependency compile-time required', () => {
    expect(compileTimeLiveGateContract).toEqual([true, true, true, true, true]);
  });
  it('shares one live flag source across commands, tools, guards, evaluator, coordinator, and workers', () => {
    const runtime = readFileSync(new URL('./runtime.ts', import.meta.url), 'utf-8');
    const factory = readFileSync(new URL('./sessionAutomationRuntime.ts', import.meta.url), 'utf-8');

    expect(runtime.match(/createSessionAutomationFlagSource\(config\)/g)).toHaveLength(1);
    expect(runtime).toContain('flagSource: sessionAutomationFlagSource');
    expect(runtime).toContain('sessionAutomationFlagSource.attachRefresh(sharedConfigRefresher.refreshIfChanged)');
    expect(runtime).toContain('sessionAutomationFlagSource.executionEnabled,sessionAutomationStore.tablePrefix,pgRunStore.runsTable)');
    expect(factory).toContain('new SessionAutomationCommandService(store, options.flagSource)');
    expect(factory).toContain('new SessionAutomationTools(options.store, options.flagSource, evaluator)');
    expect(factory.match(/options\.flagSource\.executionEnabled/g)).toHaveLength(4);
    expect(factory).toContain('options.flagSource,\n    )');
    expect(factory).not.toContain('flags?: SessionAutomationFlags');
    expect(factory).not.toContain('options.flagSource ??');
    expect(factory).not.toContain('resolveSessionAutomationFlags(options.flags)');
    expect(factory).not.toContain('executionEnabled: () => true');
    expect(factory).not.toContain('executionEnabled: () => false');
    expect(runtime).not.toContain("()=>config.sessionAutomation?.executionEnabled===true");
    expect(runtime).not.toContain('executionEnabled: () => config.sessionAutomation?.executionEnabled === true');
  });
});
