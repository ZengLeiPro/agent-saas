import { cn } from '@/lib/utils';
import { CAPABILITY_SURFACE } from '@/components/CapabilityCenter/CatalogUi';

export function WorkflowCatalogSkeleton() {
  return (
    <div
      className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"
      aria-label="正在加载 AI 同事工作流"
      aria-busy="true"
    >
      {Array.from({ length: 12 }, (_, index) => (
        <div
          key={index}
          className={cn('flex min-h-[13.5rem] flex-col p-4', CAPABILITY_SURFACE)}
          aria-hidden="true"
        >
          <div className="flex items-center justify-between gap-4">
            <div className="cap-skeleton h-3.5 w-20 rounded-full" />
            <div className="cap-skeleton h-3 w-14 rounded-full" />
          </div>
          <div className="cap-skeleton mt-5 h-5 w-4/5 rounded" />
          <div className="cap-skeleton mt-3 h-3.5 w-full rounded" />
          <div className="cap-skeleton mt-2 h-3.5 w-2/3 rounded" />
          <div className="mt-auto flex items-end justify-between gap-4 border-t border-border/50 pt-4">
            <div className="cap-skeleton h-3 w-24 rounded" />
            <div className="cap-skeleton h-8 w-20 rounded-md" />
          </div>
        </div>
      ))}
    </div>
  );
}
