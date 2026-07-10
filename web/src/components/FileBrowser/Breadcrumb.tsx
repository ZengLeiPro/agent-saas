import { ChevronRight, Home } from "lucide-react";
import { cn } from "@/lib/utils";

interface BreadcrumbProps {
  currentPath: string;
  onNavigate: (path: string) => void;
}

/**
 * 面包屑：Home 图标 + chevron 分隔 + 末段加粗。
 * 参考 Notion / Linear 的面包屑：每段是可点击 chip，末段用 foreground 强调。
 */
export function Breadcrumb({ currentPath, onNavigate }: BreadcrumbProps) {
  const segments = currentPath.split("/");
  // segments[0] = "assets"，逻辑上就是「文件」根

  return (
    <nav
      className="flex min-w-0 items-center gap-0.5 overflow-x-auto text-sm"
      aria-label="文件路径"
    >
      {segments.map((segment, i) => {
        const path = segments.slice(0, i + 1).join("/");
        const isLast = i === segments.length - 1;
        const isRoot = i === 0;

        return (
          <span key={path} className="flex shrink-0 items-center gap-0.5">
            {i > 0 && (
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
            )}
            {isLast ? (
              <span
                className={cn(
                  "flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[13px] font-semibold text-foreground",
                )}
              >
                {isRoot && <Home className="h-3.5 w-3.5" />}
                {isRoot ? "文件" : segment}
              </span>
            ) : (
              <button
                type="button"
                className={cn(
                  "flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[13px] text-muted-foreground transition-colors",
                  "hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                )}
                onClick={() => onNavigate(path)}
              >
                {isRoot && <Home className="h-3.5 w-3.5" />}
                {isRoot ? "文件" : segment}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}
