import { ChevronRight } from "lucide-react";

interface BreadcrumbProps {
  currentPath: string;
  onNavigate: (path: string) => void;
}

export function Breadcrumb({ currentPath, onNavigate }: BreadcrumbProps) {
  const segments = currentPath.split("/");
  // segments[0] = "assets", rest are subdirectories

  return (
    <nav className="flex items-center gap-0.5 overflow-x-auto text-sm">
      {segments.map((segment, i) => {
        const path = segments.slice(0, i + 1).join("/");
        const isLast = i === segments.length - 1;
        const label = i === 0 ? "文件" : segment;

        return (
          <span key={path} className="flex shrink-0 items-center gap-0.5">
            {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50" />}
            {isLast ? (
              <span className="font-medium text-foreground">{label}</span>
            ) : (
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => onNavigate(path)}
              >
                {label}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}
