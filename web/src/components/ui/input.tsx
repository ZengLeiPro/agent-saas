import * as React from "react";

import { cn } from "@/lib/utils";

type InputProps = React.ComponentProps<"input"> & {
  passwordManager?: "allow" | "ignore";
};

function Input({
  className,
  type,
  autoComplete = "off",
  passwordManager = autoComplete === "off" ? "ignore" : "allow",
  onWheel,
  ...props
}: InputProps) {
  const ignorePasswordManager = passwordManager === "ignore";

  const handleWheel = (event: React.WheelEvent<HTMLInputElement>) => {
    onWheel?.(event);
    if (type === "number" && !event.defaultPrevented && event.currentTarget === document.activeElement) {
      // number 输入框聚焦时滚轮会直接改值。先失焦可保留页面滚动，同时避免误改。
      event.currentTarget.blur();
    }
  };

  return (
    <input
      type={type}
      autoComplete={autoComplete}
      data-1p-ignore={ignorePasswordManager ? "true" : undefined}
      data-bwignore={ignorePasswordManager ? "true" : undefined}
      data-lpignore={ignorePasswordManager ? "true" : undefined}
      className={cn(
        "flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:border-foreground/30 focus-visible:outline-none focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      onWheel={handleWheel}
      {...props}
    />
  );
}

export { Input };
