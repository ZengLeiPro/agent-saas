/**
 * 模型家族筛选器（一二级视图复用）
 *
 * 4 个 toggle：全部 / Claude / GPT / 其他
 * 'all' 仅是前端 UI 概念，发请求时传 undefined（后端 family 缺省即不过滤）。
 */
import { Segmented, type SegmentedOption } from "@/components/ui/segmented";
import type { ModelFamily } from "./types";

const FAMILY_OPTIONS: SegmentedOption<ModelFamily | "all">[] = [
  { value: "all", label: "全部" },
  { value: "claude", label: "Claude" },
  { value: "gpt", label: "GPT" },
  { value: "other", label: "其他" },
];

interface Props {
  value: ModelFamily | "all";
  onChange: (v: ModelFamily | "all") => void;
}

export function FamilyFilter({ value, onChange }: Props) {
  return (
    <Segmented
      ariaLabel="模型家族"
      options={FAMILY_OPTIONS}
      value={value}
      onChange={onChange}
    />
  );
}
