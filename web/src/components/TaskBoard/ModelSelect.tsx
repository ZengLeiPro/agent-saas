import type { ModelList } from "@agent/shared";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** Select 内部的继承占位值（radix Select 不允许空字符串 value）。 */
const INHERIT_VALUE = "__inherit__";

interface ModelSelectProps {
  modelList: ModelList | null;
  /** 当前模型 ref；null 表示继承上级默认。 */
  value: string | null;
  onChange: (value: string | null) => void;
  /** 继承项的展示文案，如「继承组织默认模型」。 */
  inheritLabel: string;
  ariaLabel: string;
  disabled?: boolean;
}

/**
 * 任务看板模型选择器：与定时任务表单同一交互，第一项为继承上级默认，
 * 后续按租户模型分组列出可选模型。
 */
export function ModelSelect({
  modelList,
  value,
  onChange,
  inheritLabel,
  ariaLabel,
  disabled,
}: ModelSelectProps) {
  if (!modelList || modelList.groups.length === 0) {
    if (!value) {
      return <p className="text-sm text-muted-foreground">模型列表暂不可用</p>;
    }
    return (
      <Select
        value={value}
        onValueChange={(next) => onChange(next === INHERIT_VALUE ? null : next)}
        disabled={disabled}
      >
        <SelectTrigger aria-label={ariaLabel}><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={INHERIT_VALUE}>{inheritLabel}</SelectItem>
          <SelectItem value={value}>当前模型（{value}）</SelectItem>
        </SelectContent>
      </Select>
    );
  }
  return (
    <Select
      value={value ?? INHERIT_VALUE}
      onValueChange={(next) => onChange(next === INHERIT_VALUE ? null : next)}
      disabled={disabled}
    >
      <SelectTrigger aria-label={ariaLabel}><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value={INHERIT_VALUE}>{inheritLabel}</SelectItem>
        {modelList.showGroupNames ? (
          modelList.groups.map((group) => (
            <SelectGroup key={group.id}>
              <SelectLabel>{group.name}</SelectLabel>
              {group.models.map((model) => (
                <SelectItem key={`${group.id}/${model.id}`} value={`${group.id}/${model.id}`}>
                  {model.name}
                </SelectItem>
              ))}
            </SelectGroup>
          ))
        ) : (
          modelList.groups.flatMap((group) => group.models.map((model) => (
            <SelectItem key={`${group.id}/${model.id}`} value={`${group.id}/${model.id}`}>
              {model.name}
            </SelectItem>
          )))
        )}
      </SelectContent>
    </Select>
  );
}
