import type { AgentDwsConfigPreview } from '@agent/shared/types/agentDwsAccount';

import { Badge } from '@/components/ui/badge';

export function EffectiveConfigPreview({ preview }: { preview?: AgentDwsConfigPreview }) {
  if (!preview) return null;
  return (
    <section className="space-y-2 rounded-lg bg-muted/40 p-3" aria-label="生效配置预览">
      <h4 className="text-sm font-medium">生效配置预览</h4>
      <div className="grid gap-2 md:grid-cols-3">
        {preview.layers.map((layer) => (
          <div key={layer.source} className="rounded-md border bg-background p-2">
            <div className="flex items-center justify-between gap-2">
              <h5 className="text-xs font-medium">{layer.label}</h5>
              <Badge variant={layer.available ? 'success' : 'warning'}>
                {layer.available ? '可用' : '受限'}
              </Badge>
            </div>
            {layer.summaries.map((summary) => (
              <p key={summary} className="mt-1 text-xs text-muted-foreground">
                {summary}
              </p>
            ))}
          </div>
        ))}
      </div>
      <div className="rounded-md border border-primary/20 bg-background p-2">
        <div className="flex items-center justify-between gap-2">
          <h5 className="text-xs font-medium">{preview.effective.label}</h5>
          <Badge variant={preview.effective.status === 'available' ? 'success' : 'warning'}>
            {preview.effective.status === 'available' ? '前台可用' : '不可执行'}
          </Badge>
        </div>
        <div className="mt-1 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
          <p>
            前台：技能 {preview.effective.frontdesk.skillCount} 项、工具{' '}
            {preview.effective.frontdesk.toolCount} 项、知识源{' '}
            {preview.effective.frontdesk.sourceCount} 个
          </p>
          <p>
            Worker（
            {preview.effective.worker.status === 'task_compile_required'
              ? '任务创建时确认'
              : '当前不可用'}
            ）：技能 {preview.effective.worker.skillCount} 项、知识源{' '}
            {preview.effective.worker.sourceCount} 个、钉钉资源{' '}
            {preview.effective.worker.dwsResourceCount} 个
          </p>
          <p>完成反馈：{preview.effective.completion}</p>
          <p>任务可见范围：{preview.effective.taskVisibility}</p>
        </div>
        {preview.effective.unavailableReasons.map((reason) => (
          <p key={reason} className="mt-1 text-xs text-destructive">
            不可执行：{reason}
          </p>
        ))}
      </div>
      {preview.warnings.length ? (
        <div className="space-y-1" aria-label="配置提示">
          {preview.warnings.map((item) => (
            <p key={item.code} className="text-xs text-muted-foreground">
              {item.severity === 'warning' ? '需要处理：' : '范围说明：'}
              {item.message}
            </p>
          ))}
        </div>
      ) : null}
    </section>
  );
}
