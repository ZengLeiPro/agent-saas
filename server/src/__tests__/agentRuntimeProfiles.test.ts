import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type {
  AuthorizedToolCall,
  ToolCallContext,
  ToolDescriptor,
  ToolResult,
  ToolRuntime,
} from '../agent/toolRuntime.js';
import { createBuiltinAgentProfileRecords, getBuiltinProfileByBinding } from '../data/agentProfiles/builtins.js';
import {
  digestAgentRuntimeProfileConfig,
  parseAgentRuntimeProfileConfig,
  type AgentProfileBindingKey,
  type AgentRuntimeProfile,
  type AgentRuntimeProfileBinding,
  type AgentRuntimeProfileConfig,
  type AgentRuntimeProfileStore,
  type AgentRuntimeProfileVersion,
  type CreateAgentRuntimeProfileInput,
  type ResolvedAgentRuntimeProfile,
  type UpdateAgentRuntimeProfileDraftInput,
} from '../data/agentProfiles/types.js';
import { EventBackedApprovalStore } from '../runtime/approvalStore.js';
import {
  AgentRuntimeProfileResolver,
  applyAgentRuntimeProfile,
  filterAgentProfileSkills,
} from '../runtime/agentProfiles.js';
import { FileEventStore } from '../runtime/fileEventStore.js';
import { LegacyTranscriptProjection } from '../runtime/legacyTranscriptProjection.js';
import { RawAgentLoop } from '../runtime/rawAgentLoop.js';
import type { RuntimeSessionRecord } from '../runtime/sessionCatalog.js';
import { applyToolProfile } from '../runtime/toolProfiles.js';
import type { ModelAdapter, ModelEvent, ModelRequest, RunContext } from '../runtime/types.js';

const cleanupDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...cleanupDirs].map((path) => rm(path, { recursive: true, force: true })));
  cleanupDirs.clear();
});

class MutableProfileStore implements AgentRuntimeProfileStore {
  readonly durable = true;
  private profiles = new Map<string, AgentRuntimeProfile>();
  private versions = new Map<string, AgentRuntimeProfileVersion>();
  private bindings = new Map<AgentProfileBindingKey, AgentRuntimeProfileBinding>();

  async init() {
    const builtins = createBuiltinAgentProfileRecords('2026-07-22T00:00:00.000Z');
    this.profiles = new Map(builtins.profiles.map((item) => [item.profileId, structuredClone(item)]));
    this.versions = new Map(builtins.versions.map((item) => [item.profileVersionId, structuredClone(item)]));
    this.bindings = new Map(builtins.bindings.map((item) => [item.bindingKey, structuredClone(item)]));
  }

  async publishInstructions(bindingKey: AgentProfileBindingKey, instructions: string) {
    const binding = this.bindings.get(bindingKey)!;
    const profile = this.profiles.get(binding.profileId)!;
    const versionNumber = (profile.latestVersion?.versionNumber ?? 0) + 1;
    const config = structuredClone(profile.draftConfig);
    config.context.systemInstructions = instructions;
    const digest = digestAgentRuntimeProfileConfig(config);
    const version: AgentRuntimeProfileVersion = {
      profileVersionId: `test-${bindingKey}-v${versionNumber}`,
      profileId: profile.profileId,
      versionNumber,
      configSchemaVersion: 1,
      config,
      configDigest: digest,
      publishedBy: 'admin',
      publishedAt: new Date().toISOString(),
    };
    this.versions.set(version.profileVersionId, version);
    profile.latestVersion = version;
    profile.draftConfig = config;
    profile.draftDigest = digest;
    profile.revision += 1;
    return version;
  }

  async listProfiles() { return [...this.profiles.values()].map((item) => structuredClone(item)); }
  async getProfile(id: string) { return this.profiles.has(id) ? structuredClone(this.profiles.get(id)!) : null; }
  async listVersions(id: string) { return [...this.versions.values()].filter((item) => item.profileId === id).map((item) => structuredClone(item)); }
  async getVersion(id: string) { return this.versions.has(id) ? structuredClone(this.versions.get(id)!) : null; }
  async listBindings() { return [...this.bindings.values()].map((item) => structuredClone(item)); }
  async resolveBinding(key: AgentProfileBindingKey): Promise<ResolvedAgentRuntimeProfile | null> {
    const binding = this.bindings.get(key);
    if (!binding) return null;
    const profile = this.profiles.get(binding.profileId)!;
    const version = this.versions.get(profile.latestVersion!.profileVersionId)!;
    return { bindingKey: key, profile: structuredClone(profile), version: structuredClone(version), source: 'database' };
  }
  async createProfile(_input: CreateAgentRuntimeProfileInput): Promise<AgentRuntimeProfile> { throw new Error('unused'); }
  async copyProfile(_id: string, _input: CreateAgentRuntimeProfileInput): Promise<AgentRuntimeProfile> { throw new Error('unused'); }
  async updateDraft(_id: string, _input: UpdateAgentRuntimeProfileDraftInput): Promise<AgentRuntimeProfile> { throw new Error('unused'); }
  async publish(_id: string, _revision: number, _actor: string): Promise<AgentRuntimeProfileVersion> { throw new Error('unused'); }
  async archive(_id: string, _revision: number, _actor: string): Promise<AgentRuntimeProfile> { throw new Error('unused'); }
  async updateBinding(_key: AgentProfileBindingKey, _id: string, _actor: string): Promise<AgentRuntimeProfileBinding> { throw new Error('unused'); }
}

class StaticToolRuntime implements ToolRuntime {
  calls: string[] = [];
  constructor(private readonly descriptors: ToolDescriptor[]) {}
  list() { return this.descriptors; }
  async invoke<TInput>(call: AuthorizedToolCall<TInput>): Promise<ToolResult> {
    this.calls.push(call.toolId);
    return { content: `${call.toolId}:ok` };
  }
}

class ToolThenTextAdapter implements ModelAdapter {
  calls = 0;
  requests: ModelRequest[] = [];
  constructor(private readonly toolName: string) {}
  async *stream(request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    this.calls += 1;
    if (this.calls === 1) {
      yield { type: 'completed', content: '', toolCalls: [{ id: 'call-1', name: this.toolName, arguments: '{}' }] };
      return;
    }
    yield { type: 'text_delta', content: '完成' };
    yield { type: 'completed', content: '完成', toolCalls: [] };
  }
}

class CaptureInstructionsAdapter implements ModelAdapter {
  requests: ModelRequest[] = [];
  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    yield { type: 'completed', content: '完成', toolCalls: [] };
  }
}

const descriptors: ToolDescriptor[] = ['Read', 'Write', 'Shell', 'Agent', 'AskUserQuestion', 'CronManage', 'WaitForWorkspaceReady'].map((name) => toolDescriptor(name));

function toolDescriptor(name: string): ToolDescriptor {
  return {
  id: name,
  name,
  displayName: name,
  description: name,
  schema: z.object({}).passthrough(),
  risk: 'safe',
  approvalMode: 'never',
  auditCategory: 'test',
  };
}

describe('Agent Runtime Profile schema and runtime intersection', () => {
  it('normalizes config and keeps digest stable across key order', () => {
    const original = getBuiltinProfileByBinding('main').version.config;
    const parsed = parseAgentRuntimeProfileConfig(JSON.parse(JSON.stringify(original)));
    expect(digestAgentRuntimeProfileConfig(parsed)).toBe(digestAgentRuntimeProfileConfig(original));
  });

  it('requires WaitForWorkspaceReady when an explicit allowlist exposes workspace tools', () => {
    const config = structuredClone(getBuiltinProfileByBinding('main').version.config);
    config.tools.allowlist = ['Read'];
    expect(() => parseAgentRuntimeProfileConfig(config)).toThrow(/WaitForWorkspaceReady/);
  });

  it('intersects Profile with the already-effective global/tenant runtime and guards invoke', async () => {
    const main = getBuiltinProfileByBinding('main');
    const config = structuredClone(main.version.config);
    config.tools.allowlist = ['Read', 'Write', 'WaitForWorkspaceReady'];
    const bound = {
      profile: main.profile,
      version: { ...main.version, config },
      binding: {
        profileId: main.profile.profileId,
        profileKey: main.profile.profileKey,
        profileVersionId: main.version.profileVersionId,
        profileVersionNumber: 1,
        profileConfigDigest: digestAgentRuntimeProfileConfig(config),
        profileBindingKey: 'main' as const,
        profileResolution: 'builtin' as const,
      },
    };
    // Inner runtime represents global + tenant effective set: Write is absent.
    const inner = new StaticToolRuntime(descriptors.filter((item) => item.name === 'Read'));
    const runtime = applyAgentRuntimeProfile(inner, bound);
    expect(runtime.list().map((item) => item.name)).toEqual(['Read']);
    await expect(runtime.invoke(call('Write'), context())).rejects.toThrow(/有效工具集/);
    expect(inner.calls).toEqual([]);
  });

  it('filters eager MCP tools and only prioritizes defaults inside the existing effective skill set', () => {
    const main = getBuiltinProfileByBinding('main');
    const config = structuredClone(main.version.config);
    config.mcp.serverAllowlist = ['github'];
    config.mcp.toolAllowlist = ['search_code'];
    config.skills.defaultSkillIds = ['recommended'];
    config.skills.allowlist = ['recommended', 'ordinary'];
    config.skills.denylist = ['denied'];
    const runtime = applyAgentRuntimeProfile(new StaticToolRuntime([
      ...descriptors,
      toolDescriptor('mcp__github__search_code'),
      toolDescriptor('mcp__github__write_file'),
      toolDescriptor('mcp__notion__search'),
    ]), {
      profile: main.profile,
      version: { ...main.version, config },
      binding: {
        profileId: main.profile.profileId,
        profileKey: main.profile.profileKey,
        profileVersionId: main.version.profileVersionId,
        profileVersionNumber: 1,
        profileConfigDigest: digestAgentRuntimeProfileConfig(config),
        profileBindingKey: 'main',
        profileResolution: 'builtin',
      },
    });
    expect(runtime.list().map((item) => item.name).filter((name) => name.startsWith('mcp__')))
      .toEqual(['mcp__github__search_code']);

    const effective = [
      { id: 'ordinary', name: 'ordinary' },
      { id: 'denied', name: 'denied' },
      { id: 'recommended', name: 'recommended' },
    ];
    expect(filterAgentProfileSkills(effective, config).map((skill) => skill.id))
      .toEqual(['recommended', 'ordinary']);
    expect(filterAgentProfileSkills(effective.filter((skill) => skill.id !== 'recommended'), config).map((skill) => skill.id))
      .toEqual(['ordinary']);
  });

  it('preserves memory_poll path guard and explore/general non-removable constraints', async () => {
    const memoryInner = new StaticToolRuntime(descriptors);
    const memoryRuntime = applyToolProfile(memoryInner, 'memory_poll');
    expect(memoryRuntime.list().map((item) => item.name)).not.toContain('Shell');
    await expect(memoryRuntime.invoke(call('Write', { path: 'notes.txt' }), context())).rejects.toThrow(/MEMORY.md/);

    for (const key of ['subagent_explore', 'subagent_general'] as const) {
      const builtin = getBuiltinProfileByBinding(key);
      const runtime = applyAgentRuntimeProfile(new StaticToolRuntime(descriptors), {
        profile: builtin.profile,
        version: builtin.version,
        binding: {
          profileId: builtin.profile.profileId,
          profileKey: builtin.profile.profileKey,
          profileVersionId: builtin.version.profileVersionId,
          profileVersionNumber: 1,
          profileConfigDigest: builtin.version.configDigest,
          profileBindingKey: key,
          profileResolution: 'builtin',
        },
      });
      const visible = runtime.list().map((item) => item.name);
      expect(visible).not.toContain('Agent');
      expect(visible).not.toContain('AskUserQuestion');
      expect(visible).not.toContain('CronManage');
      if (key === 'subagent_explore') {
        expect(visible).not.toContain('Shell');
        expect(visible).not.toContain('Write');
      }
    }
  });

  it('rejects tampered pinned-session Profile identity instead of silently rebinding', async () => {
    const store = new MutableProfileStore();
    await store.init();
    const resolver = new AgentRuntimeProfileResolver(store);
    const bound = await resolver.resolveForSession({ existingSession: null, bindingKey: 'main' });
    const session = { ...sessionFromBound(bound), profileVersionNumber: 999 };
    await expect(resolver.resolveForSession({ existingSession: session, bindingKey: 'main' }))
      .rejects.toThrow(/身份字段与不可变版本不一致/);
  });
});

describe('real RawAgentLoop Profile scenarios', () => {
  it('main Profile completes a multi-turn tool task and records Profile trace', async () => {
    const main = getBuiltinProfileByBinding('main');
    const adapter = new ToolThenTextAdapter('Read');
    const inner = new StaticToolRuntime(descriptors);
    const bound = boundFromBuiltin('main');
    const { loop, eventStore } = await loopHarness(adapter, applyAgentRuntimeProfile(inner, bound));
    const events = await collect(loop.run(input('main instructions'), runContext(bound)));
    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(inner.calls).toEqual(['Read']);
    expect(adapter.calls).toBe(2);
    const started = (await eventStore.list('session-test')).find((event) => event.type === 'run_started');
    expect(started).toMatchObject({ profileVersionId: main.version.profileVersionId, profileConfigDigest: main.version.configDigest });
  });

  it('explore Profile hides write and Shell from the model and rejects direct invocation', async () => {
    const bound = boundFromBuiltin('subagent_explore');
    const inner = new StaticToolRuntime(descriptors);
    const runtime = applyAgentRuntimeProfile(inner, bound);
    const adapter = new ToolThenTextAdapter('Shell');
    const { loop } = await loopHarness(adapter, runtime);
    const events = await collect(loop.run(input('explore instructions'), runContext(bound)));
    expect(adapter.requests[0]!.tools.map((tool) => tool.name)).not.toContain('Shell');
    expect(adapter.requests[0]!.tools.map((tool) => tool.name)).not.toContain('Write');
    expect(inner.calls).toEqual([]);
    expect(events.at(-1)).toEqual({ type: 'done' });
    await expect(runtime.invoke(call('Shell'), context())).rejects.toThrow(/有效工具集/);
  });

  it('publishing v2 keeps an old session on v1 while a new session uses v2', async () => {
    const store = new MutableProfileStore();
    await store.init();
    const resolver = new AgentRuntimeProfileResolver(store);
    const oldBound = await resolver.resolveForSession({ existingSession: null, bindingKey: 'main' });
    const oldSession = sessionFromBound(oldBound);
    const v2 = await store.publishInstructions('main', 'PROFILE_V2_MARKER');
    const resumed = await resolver.resolveForSession({ existingSession: oldSession, bindingKey: 'main' });
    const fresh = await resolver.resolveForSession({ existingSession: null, bindingKey: 'main' });
    expect(resumed.version.versionNumber).toBe(1);
    expect(fresh.version.profileVersionId).toBe(v2.profileVersionId);

    const oldAdapter = new CaptureInstructionsAdapter();
    const newAdapter = new CaptureInstructionsAdapter();
    const oldHarness = await loopHarness(oldAdapter, new StaticToolRuntime([]));
    const newHarness = await loopHarness(newAdapter, new StaticToolRuntime([]));
    await collect(oldHarness.loop.run(input(resumed.version.config.context.systemInstructions || 'PROFILE_V1'), runContext(resumed)));
    await collect(newHarness.loop.run(input(fresh.version.config.context.systemInstructions), runContext(fresh)));
    expect(systemMessage(oldAdapter.requests[0]!)).not.toContain('PROFILE_V2_MARKER');
    expect(systemMessage(newAdapter.requests[0]!)).toContain('PROFILE_V2_MARKER');
  });

  it('Responses relay only reuses state produced by the same Profile config digest', async () => {
    const bound = boundFromBuiltin('main');
    const runStore = {
      findLatestResponseSessionStateBySession: async () => ({
        runId: 'previous-run',
        lastResponseId: 'resp-profile-v1',
        lastResponseModel: 'test-model',
        lastResponseProfileDigest: bound.binding.profileConfigDigest,
      }),
    };
    const matchingAdapter = new CaptureInstructionsAdapter();
    const matching = await loopHarness(matchingAdapter, new StaticToolRuntime([]), runStore);
    await collect(matching.loop.run(input('same profile'), runContext(bound)));
    expect(matchingAdapter.requests[0]?.previousResponseId).toBe('resp-profile-v1');

    const changedAdapter = new CaptureInstructionsAdapter();
    const changed = await loopHarness(changedAdapter, new StaticToolRuntime([]), runStore);
    await collect(changed.loop.run(input('changed profile'), {
      ...runContext(bound),
      profileConfigDigest: 'different-profile-digest',
    }));
    expect(changedAdapter.requests[0]?.previousResponseId).toBeUndefined();
  });
});

function boundFromBuiltin(key: AgentProfileBindingKey) {
  const builtin = getBuiltinProfileByBinding(key);
  return {
    profile: builtin.profile,
    version: builtin.version,
    binding: {
      profileId: builtin.profile.profileId,
      profileKey: builtin.profile.profileKey,
      profileVersionId: builtin.version.profileVersionId,
      profileVersionNumber: builtin.version.versionNumber,
      profileConfigDigest: builtin.version.configDigest,
      profileBindingKey: key,
      profileResolution: 'builtin' as const,
    },
  };
}

async function loopHarness(adapter: ModelAdapter, runtime: ToolRuntime, runStore?: object) {
  const root = await mkdtemp(join(tmpdir(), 'agent-profile-loop-'));
  cleanupDirs.add(root);
  const eventStore = new FileEventStore(join(root, 'events.jsonl'));
  const loop = new RawAgentLoop({
    modelAdapter: adapter,
    eventStore,
    approvalStore: new EventBackedApprovalStore(eventStore, 'session-test'),
    transcriptProjection: new LegacyTranscriptProjection(join(root, 'transcript.jsonl')),
    toolRuntime: runtime,
    runStore: runStore as never,
  });
  return { loop, eventStore };
}

function input(instructions: string) {
  return {
    message: { channel: 'web' as const, chatId: 'chat', content: '完成任务' },
    prompt: '完成任务',
    instructions,
    maxTurns: 4,
    connection: { apiKey: 'test', baseUrl: 'https://example.invalid/v1' },
  };
}

function runContext(bound: ReturnType<typeof boundFromBuiltin> | Awaited<ReturnType<AgentRuntimeProfileResolver['resolveForSession']>>): RunContext {
  return {
    runId: `run-${Math.random()}`,
    sessionId: 'session-test',
    model: 'test-model',
    cwd: '/tmp',
    channelContext: { channel: 'web', user: { id: 'u1', username: 'admin', role: 'admin' } },
    profileId: bound.binding.profileId,
    profileVersionId: bound.binding.profileVersionId,
    profileConfigDigest: bound.binding.profileConfigDigest,
  };
}

function sessionFromBound(bound: Awaited<ReturnType<AgentRuntimeProfileResolver['resolveForSession']>>): RuntimeSessionRecord {
  return {
    sessionId: 'old-session', userId: 'u1', username: 'admin', channel: 'web', cwd: '/tmp',
    transcriptPath: '/tmp/old-session.jsonl', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...bound.binding,
  };
}

function call(toolId: string, input: Record<string, unknown> = {}): AuthorizedToolCall {
  return { toolId, input, authorization: { approved: true, source: 'policy_auto' } };
}

function context(): ToolCallContext {
  return {
    channelContext: { channel: 'web', user: { id: 'u1', username: 'admin', role: 'admin' } },
    workspace: { root: '/tmp', executionTarget: 'server-local' },
  };
}

async function collect(iterable: AsyncIterable<unknown>) {
  const result: any[] = [];
  for await (const item of iterable) result.push(item);
  return result;
}

function systemMessage(request: ModelRequest): string {
  const message = request.messages.find((item) => item.role === 'system');
  return message && typeof message.content === 'string' ? message.content : '';
}
