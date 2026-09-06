import { useEffect, useState } from 'react';
import type {
  ModelList,
  OrgAgentExecutionTarget,
  OrgAgentRuntimeContextModule,
  OrgAgentRuntimePolicy,
} from '@agent/shared';

import { ModelSelect } from '@/components/TaskBoard/ModelSelect';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { authFetch } from '@/lib/authFetch';

interface OrgAgentRuntimeSectionProps {
  value: OrgAgentRuntimePolicy;
  onChange: (next: OrgAgentRuntimePolicy) => void;
}

const CONTEXT_MODULES: Array<{ id: OrgAgentRuntimeContextModule; label: string; hint: string }> = [
  { id: 'company_info', label: '公司信息', hint: '注入组织统一公司档案。' },
  { id: 'tenant_instructions', label: '组织规则', hint: '注入组织级系统规则。' },
  { id: 'runtime_memory', label: '长程记忆上下文', hint: '配合“完整读写”记忆范围使用。' },
];

const CAPABILITIES: Array<{ key: keyof OrgAgentRuntimePolicy['capabilities']; label: string; hint: string }> = [
  { key: 'shell', label: 'Shell 与工作区', hint: '允许使用 Shell；仍受组织 Profile 与审批约束。' },
  { key: 'backgroundTasks', label: '后台任务', hint: '允许启动和治理后台命令或 Agent。' },
  { key: 'interaction', label: '交互提问', hint: '允许使用 AskUserQuestion 等交互能力。' },
  { key: 'subagents', label: '子 Agent', hint: '允许派生独立子 Agent。' },
  { key: 'scheduling', label: '定时任务', hint: '允许创建和管理 Cron。' },
];

const EXECUTION_TARGETS: Array<{ id: OrgAgentExecutionTarget; label: string }> = [
  { id: 'server-local', label: '服务端本地' },
  { id: 'server-container', label: '服务端容器' },
  { id: 'server-remote', label: '远程工作区' },
  { id: 'client', label: '客户端' },
];

function parseList(text: string): string[] {
  return [...new Set(text.split(/[\n,]/).map(item => item.trim()).filter(Boolean))];
}

function formatList(items: string[] | null): string {
  return (items ?? []).join('\n');
}

function toggle<T extends string>(items: readonly T[], item: T, checked: boolean): T[] {
  return checked ? [...new Set([...items, item])] : items.filter(value => value !== item);
}

function PolicyListField({
  label,
  hint,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  hint: string;
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <p className="text-xs text-muted-foreground">{hint}</p>
      <textarea
        className="min-h-20 w-full rounded-md border bg-background px-3 py-2 font-mono text-xs"
        value={formatList(value)}
        onChange={event => onChange(parseList(event.target.value))}
        placeholder={placeholder}
        autoComplete="off"
      />
    </div>
  );
}

export function OrgAgentRuntimeSection({ value, onChange }: OrgAgentRuntimeSectionProps) {
  const [modelList, setModelList] = useState<ModelList | null>(null);

  useEffect(() => {
    let cancelled = false;
    void authFetch('/api/models')
      .then(response => response.ok ? response.json() as Promise<ModelList> : null)
      .then(next => { if (!cancelled && next) setModelList(next); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const patch = <K extends keyof OrgAgentRuntimePolicy>(key: K, next: OrgAgentRuntimePolicy[K]) => {
    onChange({ ...value, [key]: next });
  };
  const fixedModel = value.model.strategy === 'fixed' ? value.model.modelRef : null;
  const fixedWorkerModel = value.workerModel.strategy === 'fixed' ? value.workerModel.modelRef : null;
  const setExecutionMode = (executionMode: OrgAgentRuntimePolicy['executionMode']) => {
    if (executionMode === 'direct') {
      onChange({ ...value, executionMode });
      return;
    }
    onChange({
      ...value,
      executionMode,
      capabilities: {
        ...value.capabilities,
        backgroundTasks: 'inherit',
        subagents: 'inherit',
      },
    });
  };
  const customContext = value.context.modules !== null;
  const toolAllowlistLimited = value.tools.allowlist !== null;
  const mcpServerLimited = value.mcp.serverAllowlist !== null;
  const mcpToolLimited = value.mcp.toolAllowlist !== null;
  const appSystemLimited = value.apps.systemAllowlist !== null;
  const appCapabilityLimited = value.apps.capabilityAllowlist !== null;
  const executionLimited = value.execution.allowedTargets !== null;

  return (
    <section className="space-y-4 rounded-xl border p-4" aria-labelledby="org-agent-runtime-title">
      <div className="space-y-1">
        <h3 id="org-agent-runtime-title" className="text-sm font-semibold">运行策略</h3>
        <p className="text-xs leading-5 text-muted-foreground">
          这些配置只作用于当前企业专家。工具、MCP、执行环境和能力开关只能在组织默认策略上继续收窄，不会绕过权限或审批。
        </p>
      </div>

      <div className="space-y-2">
        <Label>工作模式</Label>
        <div role="radiogroup" aria-label="企业专家工作模式" className="grid gap-2 md:grid-cols-2">
          <label className="flex cursor-pointer gap-3 rounded-md border p-3">
            <input
              type="radio"
              name="org-agent-execution-mode"
              value="direct"
              checked={value.executionMode === 'direct'}
              onChange={() => setExecutionMode('direct')}
            />
            <span><span className="block text-sm font-medium">自主执行</span><span className="block text-xs leading-5 text-muted-foreground">当前 Agent 直接使用受治理工具完成工作。</span></span>
          </label>
          <label className="flex cursor-pointer gap-3 rounded-md border p-3">
            <input
              type="radio"
              name="org-agent-execution-mode"
              value="dispatcher"
              checked={value.executionMode === 'dispatcher'}
              onChange={() => setExecutionMode('dispatcher')}
            />
            <span><span className="block text-sm font-medium">前台调度器</span><span className="block text-xs leading-5 text-muted-foreground">前台只接单、澄清和汇报，实际工作交给独立后台 Worker；可并行接收新任务，但会增加一次模型调度及相应用量。</span></span>
          </label>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label>前台模型</Label>
          <ModelSelect
            modelList={modelList}
            value={fixedModel}
            onChange={modelRef => patch('model', modelRef ? { strategy: 'fixed', modelRef } : { strategy: 'inherit' })}
            inheritLabel="继承组织 Agent 默认模型"
            ariaLabel="企业专家模型"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="org-agent-max-turns">最大轮次</Label>
          <Input
            id="org-agent-max-turns"
            type="number"
            min={1}
            max={1000}
            value={value.limits.maxTurns ?? ''}
            onChange={event => patch('limits', {
              maxTurns: event.target.value ? Math.max(1, Math.min(1000, Number(event.target.value))) : null,
            })}
            placeholder="继承组织默认"
          />
        </div>
      </div>

      {value.executionMode === 'dispatcher' ? (
        <div className="space-y-1.5 rounded-md border border-dashed p-3">
          <Label>Worker 模型</Label>
          <p className="text-xs text-muted-foreground">默认继承前台模型，也可选择当前组织允许的独立模型；保存时会校验后台 Agent、Runtime Profile 和模型连接。</p>
          <ModelSelect
            modelList={modelList}
            value={fixedWorkerModel}
            onChange={modelRef => patch('workerModel', modelRef ? { strategy: 'fixed', modelRef } : { strategy: 'inherit' })}
            inheritLabel="继承组织 Agent 模型"
            ariaLabel="企业专家 Worker 模型"
          />
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label>记忆范围</Label>
          <select
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            value={value.memory.scope}
            onChange={event => patch('memory', { scope: event.target.value as OrgAgentRuntimePolicy['memory']['scope'] })}
          >
            <option value="inherit">继承组织默认</option>
            <option value="full">完整读写</option>
            <option value="search_only">只允许搜索</option>
            <option value="none">关闭长程记忆</option>
          </select>
        </div>
        <div className="space-y-2 rounded-md border border-dashed p-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-medium">自定义上下文模块</div>
              <div className="text-xs text-muted-foreground">关闭时继承组织 Agent 默认模块。</div>
            </div>
            <Switch
              checked={customContext}
              onCheckedChange={checked => patch('context', { modules: checked ? [] : null })}
            />
          </div>
          {customContext ? CONTEXT_MODULES.map(module => (
            <label key={module.id} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={value.context.modules?.includes(module.id) ?? false}
                onChange={event => patch('context', {
                  modules: toggle(value.context.modules ?? [], module.id, event.target.checked),
                })}
              />
              <span><span className="block font-medium">{module.label}</span><span className="block text-xs text-muted-foreground">{module.hint}</span></span>
            </label>
          )) : null}
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-sm font-medium">能力开关</div>
        <div className="grid gap-2 md:grid-cols-2">
          {CAPABILITIES.map(capability => (
            <div key={capability.key} className="flex items-start justify-between gap-3 rounded-md border px-3 py-2">
              <div><div className="text-sm font-medium">{capability.label}</div><div className="text-xs text-muted-foreground">{capability.hint}</div></div>
              <Switch
                aria-label={capability.label}
                checked={value.capabilities[capability.key] !== 'disabled'}
                disabled={value.executionMode === 'dispatcher'
                  && (capability.key === 'backgroundTasks' || capability.key === 'subagents')}
                onCheckedChange={checked => patch('capabilities', {
                  ...value.capabilities,
                  [capability.key]: checked ? 'inherit' : 'disabled',
                })}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-3 rounded-md border border-dashed p-3">
        <div className="flex items-start justify-between gap-3">
          <div><div className="text-sm font-medium">限制可用工具</div><div className="text-xs text-muted-foreground">关闭表示继承；dispatcher 模式仅约束 Worker，前台派发工具由运行时保留。</div></div>
          <Switch checked={toolAllowlistLimited} onCheckedChange={checked => patch('tools', { ...value.tools, allowlist: checked ? [] : null })} />
        </div>
        {toolAllowlistLimited ? (
          <PolicyListField
            label="工具允许列表"
            hint="每行一个工具名。使用 Read / Write / Edit / Shell 时必须同时包含 WaitForWorkspaceReady。"
            value={value.tools.allowlist ?? []}
            onChange={allowlist => patch('tools', { ...value.tools, allowlist })}
            placeholder={'Read\nWrite\nEdit\nShell\nWaitForWorkspaceReady'}
          />
        ) : null}
        <PolicyListField
          label="工具拒绝列表"
          hint="每行一个工具名；拒绝规则优先。"
          value={value.tools.denylist}
          onChange={denylist => patch('tools', { ...value.tools, denylist })}
          placeholder={'GenerateImage\nCronManage'}
        />
      </div>

      <div className="space-y-3 rounded-md border border-dashed p-3">
        <div className="text-sm font-medium">MCP 策略</div>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3"><span className="text-sm">限制 Server</span><Switch checked={mcpServerLimited} onCheckedChange={checked => patch('mcp', { ...value.mcp, serverAllowlist: checked ? [] : null })} /></div>
            {mcpServerLimited ? <PolicyListField label="Server 允许列表" hint="每行一个 MCP Server 名。" value={value.mcp.serverAllowlist ?? []} onChange={serverAllowlist => patch('mcp', { ...value.mcp, serverAllowlist })} /> : null}
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3"><span className="text-sm">限制工具</span><Switch checked={mcpToolLimited} onCheckedChange={checked => patch('mcp', { ...value.mcp, toolAllowlist: checked ? [] : null })} /></div>
            {mcpToolLimited ? <PolicyListField label="MCP 工具允许列表" hint="每行一个工具名或完整 MCP tool key。" value={value.mcp.toolAllowlist ?? []} onChange={toolAllowlist => patch('mcp', { ...value.mcp, toolAllowlist })} /> : null}
          </div>
          <PolicyListField label="拒绝 Server" hint="每行一个 MCP Server 名。" value={value.mcp.denyServers} onChange={denyServers => patch('mcp', { ...value.mcp, denyServers })} />
          <PolicyListField label="拒绝 MCP 工具" hint="每行一个工具名或完整 key。" value={value.mcp.denyTools} onChange={denyTools => patch('mcp', { ...value.mcp, denyTools })} />
        </div>
      </div>

      <div className="space-y-3 rounded-md border border-dashed p-3">
        <div className="text-sm font-medium">定制系统策略</div>
        <p className="text-xs leading-5 text-muted-foreground">
          控制这个企业专家能用哪些定制系统的能力。写规范化后的标识（连字符和点都写成下划线）。
          注意：上面的「工具允许列表」一旦开启，未列名的定制系统能力会被一并滤掉。
        </p>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3"><span className="text-sm">限制系统</span><Switch checked={appSystemLimited} onCheckedChange={checked => patch('apps', { ...value.apps, systemAllowlist: checked ? [] : null })} /></div>
            {appSystemLimited ? <PolicyListField label="系统允许列表" hint="每行一个系统标识，如 demo_erp。" value={value.apps.systemAllowlist ?? []} onChange={systemAllowlist => patch('apps', { ...value.apps, systemAllowlist })} /> : null}
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3"><span className="text-sm">限制能力</span><Switch checked={appCapabilityLimited} onCheckedChange={checked => patch('apps', { ...value.apps, capabilityAllowlist: checked ? [] : null })} /></div>
            {appCapabilityLimited ? <PolicyListField label="能力允许列表" hint="每行一个能力标识或完整工具名。" value={value.apps.capabilityAllowlist ?? []} onChange={capabilityAllowlist => patch('apps', { ...value.apps, capabilityAllowlist })} /> : null}
          </div>
          <PolicyListField label="拒绝系统" hint="每行一个系统标识。" value={value.apps.denySystems} onChange={denySystems => patch('apps', { ...value.apps, denySystems })} />
          <PolicyListField label="拒绝能力" hint="每行一个能力标识或完整工具名。" value={value.apps.denyCapabilities} onChange={denyCapabilities => patch('apps', { ...value.apps, denyCapabilities })} />
        </div>
      </div>

      <div className="space-y-3 rounded-md border border-dashed p-3">
        <div className="flex items-start justify-between gap-3">
          <div><div className="text-sm font-medium">限制执行环境</div><div className="text-xs text-muted-foreground">关闭时继承组织默认；开启后只允许勾选的目标。</div></div>
          <Switch checked={executionLimited} onCheckedChange={checked => patch('execution', { allowedTargets: checked ? [] : null })} />
        </div>
        {executionLimited ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {EXECUTION_TARGETS.map(target => (
              <label key={target.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={value.execution.allowedTargets?.includes(target.id) ?? false}
                  onChange={event => patch('execution', { allowedTargets: toggle(value.execution.allowedTargets ?? [], target.id, event.target.checked) })}
                />
                {target.label}
              </label>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
