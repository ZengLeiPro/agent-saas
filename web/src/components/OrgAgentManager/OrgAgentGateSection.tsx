import { useState } from 'react';
import { Loader2, PlayCircle, Plus, X } from 'lucide-react';
import { authFetch } from '@/lib/authFetch';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  assembleScopeDescription,
  type OrgAgentFormValues,
  type OrgAgentGuardrailMode,
} from './types';

/** 门禁三档语义说明（radio label 旁的副标题） */
const GATE_MODE_META: Array<{ value: OrgAgentGuardrailMode; label: string; hint: string }> = [
  { value: 'off', label: '关闭', hint: '不跑门禁；所有问题都进入主对话。' },
  {
    value: 'shadow',
    label: '影子模式',
    hint: '跑门禁并落库审计，但判定不生效——用于上线前 3-7 天调 scope。',
  },
  { value: 'enforce', label: '生效', hint: '门禁生效，超范围问题直接返回拒绝话术，不进入主对话。' },
];

export interface GateTestResult {
  verdict?: 'in_scope' | 'off_topic' | 'uncertain';
  wouldReject?: boolean;
  latencyMs?: number;
  reason?: string;
  source?: string;
  model?: string;
  error?: string;
}

type GateValues = Pick<
  OrgAgentFormValues,
  | 'description'
  | 'guardrailMode'
  | 'guardrailAllowExamples'
  | 'guardrailRejectExamples'
  | 'guardrailStrictness'
  | 'guardrailRejectionMessage'
  | 'guardrailScopeDescription'
>;

type GatePatch = Partial<Omit<GateValues, 'description'>>;

/**
 * 门禁配置：填空题式（允许问 / 拒绝问 chips + 三档 mode radio + strictness radio + 试测按钮）
 * 本地草稿与试测状态由本组件持有；父表单通过 key 重置。
 */
export function OrgAgentGateSection({
  values,
  agentId,
  onChange,
  onError,
}: {
  values: GateValues;
  /** 编辑目标 id；新建时为空，走 dry-run 端点 */
  agentId?: string | null;
  onChange: (patch: GatePatch) => void;
  onError: (message: string) => void;
}) {
  const [newAllowExample, setNewAllowExample] = useState('');
  const [newRejectExample, setNewRejectExample] = useState('');
  const [gateTestOpen, setGateTestOpen] = useState(false);
  const [gateTestMessage, setGateTestMessage] = useState('');
  const [gateTestRunning, setGateTestRunning] = useState(false);
  const [gateTestResult, setGateTestResult] = useState<GateTestResult | null>(null);

  const addAllowExample = () => {
    const trimmed = newAllowExample.trim();
    if (!trimmed) return;
    if (values.guardrailAllowExamples.includes(trimmed)) {
      setNewAllowExample('');
      return;
    }
    if (values.guardrailAllowExamples.length >= 10) {
      onError('允许问示例最多 10 条');
      return;
    }
    onChange({ guardrailAllowExamples: [...values.guardrailAllowExamples, trimmed] });
    setNewAllowExample('');
  };

  const removeAllowExample = (item: string) => {
    onChange({ guardrailAllowExamples: values.guardrailAllowExamples.filter((e) => e !== item) });
  };

  const addRejectExample = () => {
    const trimmed = newRejectExample.trim();
    if (!trimmed) return;
    if (values.guardrailRejectExamples.includes(trimmed)) {
      setNewRejectExample('');
      return;
    }
    if (values.guardrailRejectExamples.length >= 10) {
      onError('拒绝问示例最多 10 条');
      return;
    }
    onChange({ guardrailRejectExamples: [...values.guardrailRejectExamples, trimmed] });
    setNewRejectExample('');
  };

  const removeRejectExample = (item: string) => {
    onChange({ guardrailRejectExamples: values.guardrailRejectExamples.filter((e) => e !== item) });
  };

  const buildAssembledScope = (): string =>
    assembleScopeDescription({
      mode: values.guardrailMode,
      description: values.description,
      allowExamples: values.guardrailAllowExamples,
      rejectExamples: values.guardrailRejectExamples,
      strictness: values.guardrailStrictness,
      rawScope: values.guardrailScopeDescription,
    });

  const runGateTest = async () => {
    const message = gateTestMessage.trim();
    if (!message) {
      setGateTestResult({ error: '请输入测试问题' });
      return;
    }
    setGateTestRunning(true);
    setGateTestResult(null);
    try {
      // 编辑模式走 /:id/gate-preview（B2 已实现）；新建模式无 id，用 dry-run 端点。
      // 端点未上线时 fallback：本地判断 keyword 命中给 verdict，标记 source=local。
      const path = agentId
        ? `/api/org-agents/${encodeURIComponent(agentId)}/gate-preview`
        : '/api/org-agents/gate-preview';
      const res = await authFetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          testMessage: message,
          overrideScopeDescription: buildAssembledScope(),
          overrideStrictness: values.guardrailStrictness,
        }),
      });
      if (!res.ok) {
        // 后端还没接线时给出本地占位提示（不是硬失败）
        if (res.status === 404) {
          setGateTestResult({
            error: '后端 gate-preview 端点尚未部署（B2 计划内），本地无法预判。',
          });
        } else {
          const data = await res.json().catch(() => ({}));
          setGateTestResult({
            error: (data as { error?: string }).error || `请求失败：${res.status}`,
          });
        }
        return;
      }
      const data = (await res.json()) as GateTestResult;
      setGateTestResult(data);
    } catch (err) {
      setGateTestResult({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      setGateTestRunning(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs leading-5 text-muted-foreground">
        只回答职责内的问题<span className="text-muted-foreground/80">（话题门禁）</span>。不用写
        prompt，告诉门禁「允许问什么 / 拒绝问什么」即可——保存时自动拼装。
      </p>

      <div className="space-y-1.5">
        <Label>门禁模式</Label>
        <div role="radiogroup" aria-label="门禁模式" className="space-y-1">
          {GATE_MODE_META.map((mode) => (
            <label
              key={mode.value}
              className="flex items-start gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/40"
            >
              <input
                type="radio"
                className="mt-1"
                name="guardrail-mode"
                value={mode.value}
                checked={values.guardrailMode === mode.value}
                onChange={() => onChange({ guardrailMode: mode.value })}
              />
              <span className="min-w-0">
                <span className="block font-medium">{mode.label}</span>
                <span className="block text-xs text-muted-foreground">{mode.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      {values.guardrailMode !== 'off' && (
        <>
          <div className="space-y-1.5">
            <Label>允许问的问题类型</Label>
            <p className="text-xs text-muted-foreground">
              举 3-5 个例子，越具体越好。回车或点"添加"入列表。
            </p>
            {values.guardrailAllowExamples.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {values.guardrailAllowExamples.map((item) => (
                  <Badge
                    key={item}
                    className="max-w-full items-center gap-1 border-0 bg-success/15 text-success"
                  >
                    <span className="truncate">{item}</span>
                    <button
                      type="button"
                      aria-label={`删除允许项 ${item}`}
                      className="inline-flex size-4 items-center justify-center rounded-full hover:bg-success/25"
                      onClick={() => removeAllowExample(item)}
                    >
                      <X className="size-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
            <div className="flex items-center gap-1.5">
              <Input
                value={newAllowExample}
                onChange={(e) => setNewAllowExample(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addAllowExample();
                  }
                }}
                placeholder="如：帮我审这份报价单"
                maxLength={200}
                aria-label="新增允许问示例"
              />
              <Button type="button" variant="outline" size="sm" onClick={addAllowExample}>
                <Plus className="mr-1 size-3" />
                添加
              </Button>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>拒绝问的问题类型</Label>
            <p className="text-xs text-muted-foreground">举 3-5 个例子，帮助门禁识别越界问题。</p>
            {values.guardrailRejectExamples.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {values.guardrailRejectExamples.map((item) => (
                  <Badge
                    key={item}
                    className="max-w-full items-center gap-1 border-0 bg-destructive/15 text-destructive"
                  >
                    <span className="truncate">{item}</span>
                    <button
                      type="button"
                      aria-label={`删除拒绝项 ${item}`}
                      className="inline-flex size-4 items-center justify-center rounded-full hover:bg-destructive/25"
                      onClick={() => removeRejectExample(item)}
                    >
                      <X className="size-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
            <div className="flex items-center gap-1.5">
              <Input
                value={newRejectExample}
                onChange={(e) => setNewRejectExample(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addRejectExample();
                  }
                }}
                placeholder="如：帮我写周报"
                maxLength={200}
                aria-label="新增拒绝问示例"
              />
              <Button type="button" variant="outline" size="sm" onClick={addRejectExample}>
                <Plus className="mr-1 size-3" />
                添加
              </Button>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>拿不准时倾向</Label>
            <div role="radiogroup" aria-label="拿不准时倾向" className="space-y-1">
              <label className="flex items-start gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/40">
                <input
                  type="radio"
                  className="mt-1"
                  name="guardrail-strictness"
                  value="strict"
                  checked={values.guardrailStrictness === 'strict'}
                  onChange={() => onChange({ guardrailStrictness: 'strict' })}
                />
                <span className="min-w-0">
                  <span className="block font-medium">严格（拿不准 → 拒绝）</span>
                  <span className="block text-xs text-muted-foreground">
                    推荐用于报价、合同、法务等严肃业务。
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/40">
                <input
                  type="radio"
                  className="mt-1"
                  name="guardrail-strictness"
                  value="lenient"
                  checked={values.guardrailStrictness === 'lenient'}
                  onChange={() => onChange({ guardrailStrictness: 'lenient' })}
                />
                <span className="min-w-0">
                  <span className="block font-medium">宽松（拿不准 → 放行并打标）</span>
                  <span className="block text-xs text-muted-foreground">
                    推荐用于查询、情报类边界模糊场景。
                  </span>
                </span>
              </label>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>拒绝话术</Label>
            <Input
              value={values.guardrailRejectionMessage}
              maxLength={500}
              onChange={(e) => onChange({ guardrailRejectionMessage: e.target.value })}
            />
          </div>

          <div className="space-y-1.5">
            <Label>补充说明（可选）</Label>
            <textarea
              autoComplete="off"
              className="min-h-16 w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={values.guardrailScopeDescription}
              maxLength={2000}
              onChange={(e) => onChange({ guardrailScopeDescription: e.target.value })}
              placeholder="想额外交代门禁的话（不必填）；填空题已覆盖大部分场景。"
            />
          </div>

          <div className="flex items-center justify-between rounded-md border border-dashed bg-muted/30 px-3 py-2">
            <div className="min-w-0 space-y-0.5">
              <div className="text-xs font-medium">试测门禁</div>
              <div className="text-xs text-muted-foreground">
                输入 1 条测试问题，立即看门禁怎么判（判定 / 置信度 / 延迟）。
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setGateTestOpen((prev) => !prev);
                setGateTestResult(null);
              }}
            >
              <PlayCircle className="mr-1 size-3.5" />
              {gateTestOpen ? '收起' : '试测门禁'}
            </Button>
          </div>

          {gateTestOpen && (
            <div className="space-y-2 rounded-md border bg-background p-3">
              <div className="flex items-center gap-1.5">
                <Input
                  value={gateTestMessage}
                  onChange={(e) => setGateTestMessage(e.target.value)}
                  placeholder="如：帮我审这份报价单"
                  maxLength={2000}
                  aria-label="试测问题"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void runGateTest();
                    }
                  }}
                />
                <Button
                  type="button"
                  size="sm"
                  onClick={() => {
                    void runGateTest();
                  }}
                  disabled={gateTestRunning || !gateTestMessage.trim()}
                >
                  {gateTestRunning ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
                  {gateTestRunning ? '试测中...' : '试测'}
                </Button>
              </div>
              {gateTestResult && <GateTestResultView result={gateTestResult} />}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function GateTestResultView({ result }: { result: GateTestResult }) {
  if (result.error) {
    return (
      <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
        {result.error}
      </div>
    );
  }
  const verdict = result.verdict;
  const label =
    verdict === 'in_scope'
      ? '通过（in_scope）'
      : verdict === 'off_topic'
        ? '拒答（off_topic）'
        : verdict === 'uncertain'
          ? '边界（uncertain）'
          : '未知';
  const color =
    verdict === 'in_scope'
      ? 'text-success'
      : verdict === 'off_topic'
        ? 'text-destructive'
        : 'text-amber-600';
  return (
    <div className="space-y-1 text-xs">
      <div className={`font-medium ${color}`}>{label}</div>
      {typeof result.wouldReject === 'boolean' && (
        <div className="text-muted-foreground">
          实际动作：{result.wouldReject ? '返回拒绝话术' : '进入主对话'}
        </div>
      )}
      {typeof result.latencyMs === 'number' && (
        <div className="text-muted-foreground">延迟：{result.latencyMs} ms</div>
      )}
      {result.model && <div className="text-muted-foreground">模型：{result.model}</div>}
      {result.reason && (
        <div className="rounded bg-muted/40 px-2 py-1 text-muted-foreground">{result.reason}</div>
      )}
    </div>
  );
}
