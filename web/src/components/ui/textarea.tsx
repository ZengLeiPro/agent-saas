import * as React from "react";

import { cn } from "@/lib/utils";

function Textarea({ className, autoComplete = "off", ...props }: React.ComponentProps<"textarea">) {
  const ignorePasswordManager = autoComplete === "off";

  return (
    <textarea
      autoComplete={autoComplete}
      data-1p-ignore={ignorePasswordManager ? "true" : undefined}
      data-bwignore={ignorePasswordManager ? "true" : undefined}
      data-lpignore={ignorePasswordManager ? "true" : undefined}
      className={cn(
        "flex min-h-[60px] w-full rounded-md border border-input bg-card px-3 py-2 text-base md:text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  );
}

export { Textarea };
