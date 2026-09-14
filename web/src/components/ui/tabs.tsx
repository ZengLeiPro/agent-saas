import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";

import { cn } from "@/lib/utils";

const Tabs = TabsPrimitive.Root;

type PageTabsVariant = "primary" | "secondary";
type PageTabsLayout = "auto" | "compact" | "full";

type PageTabsPresentation = {
  variant: PageTabsVariant;
  layout: Exclude<PageTabsLayout, "auto">;
  count: number;
};

const PageTabsContext = React.createContext<PageTabsPresentation | null>(null);

function resolvePageTabsLayout(
  variant: PageTabsVariant,
  count: number,
  layout: PageTabsLayout = "auto",
): Exclude<PageTabsLayout, "auto"> {
  if (layout !== "auto") return layout;
  return count >= (variant === "primary" ? 4 : 5) ? "full" : "compact";
}

function pageTabsListClass({
  variant,
  count,
  layout = "auto",
}: {
  variant: PageTabsVariant;
  count: number;
  layout?: PageTabsLayout;
}) {
  const resolvedLayout = resolvePageTabsLayout(variant, count, layout);
  return cn(
    "flex max-w-full items-stretch justify-start gap-0.5 overflow-x-auto text-muted-foreground",
    variant === "primary"
      ? "h-11 rounded-xl border bg-card p-1 shadow-sm"
      : "h-10 rounded-lg bg-muted/60 p-1",
    resolvedLayout === "full"
      ? "w-full"
      : count <= 2
        ? variant === "primary"
          ? "w-full md:w-72"
          : "w-full md:w-56"
        : variant === "primary"
          ? "w-full md:w-[27rem]"
          : "w-full md:w-[21rem]",
  );
}

function pageTabTriggerClass({
  variant,
  layout,
}: Pick<PageTabsPresentation, "variant" | "layout">) {
  return cn(
    "h-full shrink-0 border-0 text-sm font-medium shadow-none",
    layout === "full" ? "min-w-28 basis-0 grow shrink-0" : "min-w-0 flex-1",
    variant === "primary"
      ? "rounded-lg px-4 py-2 text-muted-foreground data-[state=active]:bg-brand-accent-soft data-[state=active]:text-foreground data-[state=active]:shadow-none"
      : "rounded-md px-3 py-1.5 text-muted-foreground data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-sm",
  );
}

type TabsListProps = React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> & {
  variant?: "default" | PageTabsVariant;
  layout?: PageTabsLayout;
};

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  TabsListProps
>(({ className, variant = "default", layout = "auto", children, ...props }, ref) => {
  if (variant === "default") {
    return (
      <TabsPrimitive.List
        ref={ref}
        className={cn(
          "inline-flex h-9 items-center justify-center rounded-lg bg-muted p-1 text-muted-foreground",
          className,
        )}
        {...props}
      >
        {children}
      </TabsPrimitive.List>
    );
  }

  const count = React.Children.toArray(children).length;
  const resolvedLayout = resolvePageTabsLayout(variant, count, layout);
  return (
    <PageTabsContext.Provider value={{ variant, layout: resolvedLayout, count }}>
      <TabsPrimitive.List
        ref={ref}
        className={cn(pageTabsListClass({ variant, count, layout }), className)}
        data-tabs-layout={resolvedLayout}
        data-tabs-variant={variant}
        {...props}
      >
        {children}
      </TabsPrimitive.List>
    </PageTabsContext.Provider>
  );
});
TabsList.displayName = TabsPrimitive.List.displayName;

type TabsTriggerProps = React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger> & {
  variant?: "default" | PageTabsVariant;
};

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  TabsTriggerProps
>(({ className, variant, ...props }, ref) => {
  const presentation = React.useContext(PageTabsContext);
  const resolvedVariant = variant ?? presentation?.variant ?? "default";
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center whitespace-nowrap ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
        resolvedVariant === "default"
          ? "rounded-md px-3 py-1 text-sm font-medium data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow"
          : pageTabTriggerClass({
              variant: resolvedVariant,
              layout: presentation?.layout ?? "compact",
            }),
        className,
      )}
      {...props}
    />
  );
});
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      "mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 data-[state=inactive]:hidden",
      className
    )}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  pageTabsListClass,
  pageTabTriggerClass,
  resolvePageTabsLayout,
};
export type { PageTabsLayout, PageTabsVariant };
