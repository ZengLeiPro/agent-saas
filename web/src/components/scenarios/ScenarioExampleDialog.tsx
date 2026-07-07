/**
 * 场景示例结果弹层
 *
 * 展示预生成的黄金示例交付物（exampleResult.body，markdown）：
 * 顶部由 UI 固定渲染免责 banner（不依赖 markdown 内容自带），
 * 正文复用 MarkdownReadonly（自带懒加载的 markdown 渲染 + 滚动容器），
 * 底部「换成我的资料」= 现有预填起手话术行为，由上层关闭弹层后预填。
 *
 * 本组件被 ScenarioCard 懒加载（仅在点开时挂载），避免把弹层代码
 * 拖进空会话推荐位所在的聊天主 bundle。
 */
import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MarkdownReadonly } from "@/components/MarkdownReadonly";
import type { ScenarioItem } from "@agent/shared";

export const EXAMPLE_DISCLAIMER =
  "以下为示例数据的演示效果，非贵司真实数据。换成您的资料后，AI 同事将基于真实数据输出。";

interface ScenarioExampleDialogProps {
  scenario: ScenarioItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 底部行动按钮：行为 = 现有预填起手话术；上层负责先关闭弹层 */
  onUseMyData: (scenario: ScenarioItem) => void;
}

export function ScenarioExampleDialog({
  scenario,
  open,
  onOpenChange,
  onUseMyData,
}: ScenarioExampleDialogProps) {
  const example = scenario.exampleResult;
  if (!example) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="pr-6 text-left">
            {scenario.title} · 示例结果
          </DialogTitle>
          <DialogDescription className="sr-only">
            这是一份预生成的示例交付物，展示该场景跑完后的样子
          </DialogDescription>
        </DialogHeader>

        {/* 免责 banner：明显但不刺眼（浅警示底色 + 常规前景色） */}
        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs leading-relaxed text-foreground/80">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{EXAMPLE_DISCLAIMER}</span>
        </div>

        {/* MarkdownReadonly 自带 min-h-0 flex-1 overflow-auto，在 flex 布局中占满剩余高度并滚动 */}
        <MarkdownReadonly content={example.body} />

        <DialogFooter>
          <Button type="button" onClick={() => onUseMyData(scenario)}>
            换成我的资料
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default ScenarioExampleDialog;
