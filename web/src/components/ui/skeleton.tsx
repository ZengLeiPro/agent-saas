import { cn } from "@/lib/utils";

/**
 * 加载占位块。用于「首次加载」——已有数据的刷新不要清表换 skeleton，
 * 那会让用户丢失阅读位置。
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-muted", className)}
      aria-hidden="true"
      {...props}
    />
  );
}

export { Skeleton };
