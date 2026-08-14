import { useCallback, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Plus, RotateCcw, Trash2 } from "lucide-react";

import { DescriptionTip } from "@/components/SettingsCenter/SettingsPanelHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface TitleModel {
  id: string;
  name: string;
}

interface TitleModelGroup {
  id: string;
  name: string;
  models: TitleModel[];
}

export interface EditableTitleGeneratorConfig {
  model: string;
  fallbackModels: string[];
}

export interface EditableTitleSystemPrompt {
  content: string;
  defaultContent: string;
  overridden: boolean;
}

export interface TitleGeneratorAdminFields {
  titleGenerator: EditableTitleGeneratorConfig;
  titleSystemPrompt: EditableTitleSystemPrompt;
}

export function useTitleGeneratorSettings() {
  const [titleGenerator, setTitleGenerator] = useState<EditableTitleGeneratorConfig | null>(null);
  const [titleSystemPrompt, setTitleSystemPrompt] = useState<EditableTitleSystemPrompt | null>(null);

  const applyResponse = useCallback((data: TitleGeneratorAdminFields) => {
    setTitleGenerator({
      model: data.titleGenerator.model,
      fallbackModels: data.titleGenerator.fallbackModels ?? [],
    });
    setTitleSystemPrompt(data.titleSystemPrompt);
  }, []);

  const remapModelRefs = useCallback((mapper: (ref: string) => string | null, fallbackRef?: string) => {
    setTitleGenerator((current) => {
      if (!current) return current;
      const chain = [current.model, ...current.fallbackModels].map(mapper).filter((ref): ref is string => !!ref);
      const unique = [...new Set(chain)];
      if (unique.length === 0 && fallbackRef) unique.push(fallbackRef);
      return unique.length > 0 ? { model: unique[0]!, fallbackModels: unique.slice(1) } : current;
    });
  }, []);

  const buildPayload = useCallback(() => {
    if (!titleGenerator || !titleSystemPrompt) throw new Error("标题生成配置尚未加载");
    if (!titleSystemPrompt.content.trim()) throw new Error("标题生成提示语不能为空");
    return {
      titleGenerator: {
        model: titleGenerator.model,
        fallbackModels: titleGenerator.fallbackModels,
      },
      titleSystemPrompt: titleSystemPrompt.content.trim(),
    };
  }, [titleGenerator, titleSystemPrompt]);

  return {
    titleGenerator,
    titleSystemPrompt,
    setTitleGenerator,
    setTitleSystemPrompt,
    applyResponse,
    remapModelRefs,
    buildPayload,
  };
}

export type TitleGeneratorSettingsState = ReturnType<typeof useTitleGeneratorSettings>;

function moveItem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= items.length || toIndex >= items.length) return items;
  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved!);
  return next;
}

export function TitleGeneratorSettings(props: {
  groups: TitleModelGroup[];
  readOnly: boolean;
  settings: TitleGeneratorSettingsState;
  onDirty: () => void;
}) {
  const { groups, readOnly, settings, onDirty } = props;
  const { titleGenerator, titleSystemPrompt } = settings;
  const modelOptions = useMemo(() => groups.flatMap((group) => group.models.map((model) => ({
    ref: `${group.id}/${model.id}`,
    label: `${group.name}/${model.name}`,
  }))), [groups]);
  if (!titleGenerator || !titleSystemPrompt) return null;

  const chain = [titleGenerator.model, ...titleGenerator.fallbackModels];
  const updateChain = (next: string[]) => {
    settings.setTitleGenerator({ model: next[0]!, fallbackModels: next.slice(1) });
    onDirty();
  };
  const updatePrompt = (content: string) => {
    settings.setTitleSystemPrompt({ ...titleSystemPrompt, content });
    onDirty();
  };

  return (
    <Card className="h-fit">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-1.5 text-base">
          会话标题生成
          <DescriptionTip description="独立于会话主模型。按列表顺序调用；当前模型报错、超时或返回空内容时，自动尝试下一项。" />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <Label>模型调用顺序</Label>
              <p className="mt-1 text-xs text-muted-foreground">第 1 项是主模型，后续项依次作为 fallback。</p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={readOnly || chain.length >= modelOptions.length}
              onClick={() => {
                const used = new Set(chain);
                const nextRef = modelOptions.find((option) => !used.has(option.ref))?.ref;
                if (nextRef) updateChain([...chain, nextRef]);
              }}
            >
              <Plus className="size-3.5" />增加模型
            </Button>
          </div>
          <div className="space-y-2">
            {chain.map((ref, index) => (
              <div key={`${index}-${ref}`} className="flex items-center gap-2 rounded-md border bg-muted/15 p-2">
                <div className="flex size-7 shrink-0 items-center justify-center rounded bg-muted text-xs font-medium text-muted-foreground">{index + 1}</div>
                <div className="min-w-0 flex-1">
                  <select
                    className="h-9 w-full rounded-md border bg-card px-3 text-sm"
                    value={ref}
                    disabled={readOnly}
                    onChange={(event) => updateChain(chain.map((item, itemIndex) => itemIndex === index ? event.target.value : item))}
                  >
                    {modelOptions.map((option) => (
                      <option key={option.ref} value={option.ref} disabled={option.ref !== ref && chain.includes(option.ref)}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{ref}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button type="button" variant="ghost" size="icon" className="size-8" disabled={readOnly || index === 0} onClick={() => updateChain(moveItem(chain, index, index - 1))} aria-label={`上移第 ${index + 1} 个标题模型`}><ArrowUp className="size-3.5" /></Button>
                  <Button type="button" variant="ghost" size="icon" className="size-8" disabled={readOnly || index === chain.length - 1} onClick={() => updateChain(moveItem(chain, index, index + 1))} aria-label={`下移第 ${index + 1} 个标题模型`}><ArrowDown className="size-3.5" /></Button>
                  <Button type="button" variant="ghost" size="icon" className="size-8 text-destructive hover:text-destructive" disabled={readOnly || index === 0} onClick={() => updateChain(chain.filter((_, itemIndex) => itemIndex !== index))} aria-label={`删除第 ${index + 1} 个标题模型`}><Trash2 className="size-3.5" /></Button>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-2 border-t pt-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Label htmlFor="title-generator-prompt">标题生成提示语</Label>
              <Badge variant="secondary">{titleSystemPrompt.content === titleSystemPrompt.defaultContent ? "系统默认" : "已自定义"}</Badge>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={readOnly || titleSystemPrompt.content === titleSystemPrompt.defaultContent}
              onClick={() => updatePrompt(titleSystemPrompt.defaultContent)}
            >
              <RotateCcw className="size-3.5" />恢复默认
            </Button>
          </div>
          <Textarea
            id="title-generator-prompt"
            className="min-h-40 font-mono text-xs leading-5"
            value={titleSystemPrompt.content}
            disabled={readOnly}
            onChange={(event) => updatePrompt(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">保存后从下一次标题生成开始生效；正在执行中的调用不变。</p>
        </div>
      </CardContent>
    </Card>
  );
}
