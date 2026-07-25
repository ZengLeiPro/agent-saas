import * as React from "react";

import { cn } from "@/lib/utils";

type CardDensity = "default" | "compact";

/**
 * 密度通过 context 下发，调用点只需在 `<Card density="compact">` 写一次，
 * Header / Content / Footer 自动收窄 padding，避免每个子组件都手写一遍。
 */
const CardDensityContext = React.createContext<CardDensity>("default");

function Card({
  className,
  density = "default",
  ...props
}: React.ComponentProps<"div"> & { density?: CardDensity }) {
  return (
    <CardDensityContext.Provider value={density}>
      <div
        className={cn(
          "rounded-lg border bg-card text-card-foreground shadow-sm",
          className
        )}
        {...props}
      />
    </CardDensityContext.Provider>
  );
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  const density = React.useContext(CardDensityContext);
  return (
    <div
      className={cn(
        "flex flex-col space-y-1.5",
        density === "compact" ? "p-3 pb-1.5" : "p-6",
        className
      )}
      {...props}
    />
  );
}

/**
 * 默认值按后台真实用法定档（`text-sm font-medium`）。
 * 改造前是 `text-2xl font-semibold`，但 100% 的调用点都覆盖了它——
 * 一个默认样式被全量覆盖，等于这个组件的契约不存在。
 * 需要大号标题（对外/营销语境）请显式写 `className="text-2xl font-semibold"`。
 */
function CardTitle({ className, ...props }: React.ComponentProps<"h3">) {
  return (
    <h3
      className={cn(
        "text-sm font-medium leading-none tracking-tight",
        className
      )}
      {...props}
    />
  );
}

function CardDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p className={cn("text-sm text-muted-foreground", className)} {...props} />
  );
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  const density = React.useContext(CardDensityContext);
  return (
    <div
      className={cn(density === "compact" ? "px-3 pb-3 pt-0" : "p-6 pt-0", className)}
      {...props}
    />
  );
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  const density = React.useContext(CardDensityContext);
  return (
    <div
      className={cn(
        "flex items-center",
        density === "compact" ? "px-3 pb-3 pt-0" : "p-6 pt-0",
        className
      )}
      {...props}
    />
  );
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardDescription,
  CardContent,
  type CardDensity,
};
