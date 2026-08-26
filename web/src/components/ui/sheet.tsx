import * as React from "react";
import * as SheetPrimitive from "@radix-ui/react-dialog";
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";
import { PortalContainerProvider, usePortalContainer } from "@/components/ui/portal-container";

function Sheet(props: React.ComponentProps<typeof SheetPrimitive.Root>) {
  const { blocked } = usePortalContainer();
  return <SheetPrimitive.Root {...props} {...(blocked ? { modal: false } : {})} />;
}

const SheetTrigger = SheetPrimitive.Trigger;
const SheetClose = SheetPrimitive.Close;

function SheetPortal({ container, ...props }: React.ComponentProps<typeof SheetPrimitive.Portal>) {
  const { container: contextContainer } = usePortalContainer();
  return <SheetPrimitive.Portal container={container ?? contextContainer ?? undefined} {...props} />;
}

const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-black/60 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
  />
));
SheetOverlay.displayName = SheetPrimitive.Overlay.displayName;

const sheetVariants = cva(
  "fixed z-50 flex flex-col gap-4 bg-background shadow-lg transition ease-in-out data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:duration-300 data-[state=open]:duration-500",
  {
    variants: {
      side: {
        top: "inset-x-0 top-0 border-b data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top",
        bottom:
          "inset-x-0 bottom-0 border-t data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",
        left: "inset-y-0 left-0 h-full w-3/4 border-r data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-sm",
        /** 后台排障用得最多的一侧：详情从右滑出，背景列表保持可见可点 */
        right:
          "inset-y-0 right-0 h-full w-3/4 border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-xl",
      },
    },
    defaultVariants: { side: "right" },
  }
);

const SheetContent = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Content> &
    VariantProps<typeof sheetVariants>
>(({ side = "right", className, children, onEscapeKeyDown, onFocusOutside,
  onInteractOutside, onPointerDownOutside, ...props }, ref) => {
  const { blocked } = usePortalContainer();
  const [content, setContent] = React.useState<React.ElementRef<typeof SheetPrimitive.Content> | null>(null);
  const preventBlockedDismiss = React.useCallback((event: Event) => event.preventDefault(), []);
  const handleRef = React.useCallback((node: React.ElementRef<typeof SheetPrimitive.Content> | null) => {
    setContent(node);
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
  }, [ref]);
  const contentChildren = (
    <>
      {children}
      <SheetPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none">
        <X className="size-4" />
        <span className="sr-only">关闭</span>
      </SheetPrimitive.Close>
    </>
  );
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Content
        ref={handleRef}
        className={cn(sheetVariants({ side }), className)}
        onEscapeKeyDown={blocked ? preventBlockedDismiss : onEscapeKeyDown}
        onFocusOutside={blocked ? preventBlockedDismiss : onFocusOutside}
        onInteractOutside={blocked ? preventBlockedDismiss : onInteractOutside}
        onPointerDownOutside={blocked ? preventBlockedDismiss : onPointerDownOutside}
        {...props}
      >
        {content ? (
          <PortalContainerProvider container={content} blocked={blocked}>
            {contentChildren}
          </PortalContainerProvider>
        ) : contentChildren}
      </SheetPrimitive.Content>
    </SheetPortal>
  );
});
SheetContent.displayName = SheetPrimitive.Content.displayName;

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-col space-y-1.5 border-b px-4 py-3", className)}
      {...props}
    />
  );
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-col-reverse gap-2 border-t px-4 py-3 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    />
  );
}

const SheetTitle = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Title>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Title
    ref={ref}
    className={cn("text-base font-semibold text-foreground", className)}
    {...props}
  />
));
SheetTitle.displayName = SheetPrimitive.Title.displayName;

const SheetDescription = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Description>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
SheetDescription.displayName = SheetPrimitive.Description.displayName;

export {
  Sheet,
  SheetPortal,
  SheetOverlay,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
};
