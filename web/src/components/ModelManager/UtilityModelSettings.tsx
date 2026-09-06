import { useCallback, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import {
  TitleGeneratorSettings,
  useTitleGeneratorSettings,
  type TitleGeneratorAdminFields,
} from './TitleGeneratorSettings';

type GuardrailConfig = {
  model: string;
  fallbackModels?: string[];
  timeoutMs?: number;
  maxRecentRounds?: number;
};
type ModelGroup = {
  id: string;
  name: string;
  protocol?: string;
  models: { id: string; name: string; protocol?: string }[];
};
export type UtilityModelAdminFields = TitleGeneratorAdminFields & {
  guardrail?: GuardrailConfig | null;
};

export function useUtilityModelSettings() {
  const title = useTitleGeneratorSettings();
  const {
    applyResponse: applyTitle,
    remapModelRefs: remapTitle,
    buildPayload: titlePayload,
  } = title;
  const [guardrail, setGuardrail] = useState<GuardrailConfig | null>(null);
  const applyResponse = useCallback(
    (data: UtilityModelAdminFields) => {
      applyTitle(data);
      setGuardrail(data.guardrail ?? null);
    },
    [applyTitle],
  );
  const remapModelRefs = useCallback(
    (mapper: (ref: string) => string | null, fallbackRef?: string) => {
      remapTitle(mapper, fallbackRef);
      setGuardrail((current) => {
        if (!current) return current;
        // 删除主模型后保留悬空项，要求用户明确选择新的门禁主模型。
        const model = mapper(current.model) ?? current.model;
        const fallbackModels = [
          ...new Set(
            (current.fallbackModels ?? [])
              .map(mapper)
              .filter((ref): ref is string => !!ref && ref !== model),
          ),
        ];
        return { ...current, model, fallbackModels };
      });
    },
    [remapTitle],
  );
  const buildPayload = useCallback(
    () => ({
      ...titlePayload(),
      // 显式提交 null，允许管理员清除已经失效或协议不兼容的存量门禁配置。
      guardrail,
    }),
    [titlePayload, guardrail],
  );
  return { ...title, guardrail, setGuardrail, applyResponse, remapModelRefs, buildPayload };
}

export function UtilityModelSettings(props: {
  groups: ModelGroup[];
  readOnly: boolean;
  settings: ReturnType<typeof useUtilityModelSettings>;
  onDirty: () => void;
}) {
  const { settings, groups, readOnly, onDirty } = props;
  const guardrail = settings.guardrail;
  const configuredModels = groups.flatMap((group) => group.models.map((model) => ({
    ref: `${group.id}/${model.id}`,
    label: `${group.name}/${model.name}`,
    protocol: model.protocol ?? group.protocol ?? 'chat_completions',
  })));
  const options = configuredModels.filter((model) => model.protocol === 'chat_completions');
  const chain = guardrail ? [guardrail.model, ...(guardrail.fallbackModels ?? [])] : [];
  const unavailableLabel = (ref: string) => {
    const configured = configuredModels.find((model) => model.ref === ref);
    return configured
      ? `协议不兼容（门禁仅支持 Chat Completions）：${configured.label}`
      : `引用已失效：${ref}`;
  };
  const updateChain = (next: string[]) => {
    if (!guardrail) return;
    settings.setGuardrail({ ...guardrail, model: next[0]!, fallbackModels: next.slice(1) });
    onDirty();
  };
  return (
    <>
      <TitleGeneratorSettings {...props} />
      <Card className="h-fit">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">专职 Agent 门禁模型</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            用于判断请求是否属于专职 Agent 的工作范围；主模型失败后按顺序尝试备用模型。
          </p>
          {!guardrail ? (
            <div className="space-y-3 rounded-md border border-dashed p-3">
              <p className="text-xs text-muted-foreground">
                门禁模型当前未启用。启用前至少需要一个 Chat Completions 模型。
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={readOnly || options.length === 0}
                onClick={() => {
                  const first = options[0];
                  if (!first) return;
                  settings.setGuardrail({ model: first.ref, fallbackModels: [] });
                  onDirty();
                }}
              >
                启用门禁模型
              </Button>
            </div>
          ) : (
            <>
              {options.length === 0 && (
                <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
                  当前没有可用的 Chat Completions 模型。请将一个模型切换为 Chat Completions，或停用门禁模型后再保存。
                </p>
              )}
            {chain.map((ref, index) => (
              <div key={index} className="flex items-center gap-2">
                <Label htmlFor={`guardrail-model-${index}`} className="shrink-0">
                  {index === 0 ? '门禁主模型' : `门禁备用模型 ${index}`}
                </Label>
                <select
                  id={`guardrail-model-${index}`}
                  className="h-9 min-w-0 flex-1 rounded-md border bg-card px-3 text-sm"
                  value={ref}
                  disabled={readOnly}
                  onChange={(event) =>
                    updateChain(chain.map((item, i) => (i === index ? event.target.value : item)))
                  }
                >
                  {!options.some((option) => option.ref === ref) && (
                    <option value={ref}>{unavailableLabel(ref)}</option>
                  )}
                  {options.map((option) => (
                    <option
                      key={option.ref}
                      value={option.ref}
                      disabled={option.ref !== ref && chain.includes(option.ref)}
                    >
                      {option.label}
                    </option>
                  ))}
                </select>
                {index > 0 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={readOnly}
                    onClick={() => updateChain(chain.filter((_, i) => i !== index))}
                  >
                    删除备用模型 {index}
                  </Button>
                )}
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={readOnly || options.every((option) => chain.includes(option.ref))}
              onClick={() => {
                const next = options.find((option) => !chain.includes(option.ref));
                if (next) updateChain([...chain, next.ref]);
              }}
            >
              增加门禁备用模型
            </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={readOnly}
                onClick={() => {
                  settings.setGuardrail(null);
                  onDirty();
                }}
              >
                停用门禁模型
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </>
  );
}
