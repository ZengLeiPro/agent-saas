import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";

import { cn } from "@/lib/utils";
import { usePortalContainer } from "@/components/ui/portal-container";

function Popover(props: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  const { blocked } = usePortalContainer();
  return <PopoverPrimitive.Root {...props} {...(blocked ? { modal: false } : {})} />;
}

const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverAnchor = PopoverPrimitive.Anchor;
const PopoverClose = PopoverPrimitive.Close;

function PopoverPortal({ container, ...props }: React.ComponentProps<typeof PopoverPrimitive.Portal>) {
  const { container: contextContainer } = usePortalContainer();
  return <PopoverPrimitive.Portal container={container ?? contextContainer ?? undefined} {...props} />;
}

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "start", sideOffset = 4, onEscapeKeyDown, onFocusOutside,
  onInteractOutside, onPointerDownOutside, ...props }, ref) => {
  const { blocked } = usePortalContainer();
  const preventBlockedDismiss = React.useCallback((event: Event) => event.preventDefault(), []);
  return (
    <PopoverPortal>
      <PopoverPrimitive.Content
        ref={ref}
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-[110] w-72 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
          className
        )}
        onEscapeKeyDown={blocked ? preventBlockedDismiss : onEscapeKeyDown}
        onFocusOutside={blocked ? preventBlockedDismiss : onFocusOutside}
        onInteractOutside={blocked ? preventBlockedDismiss : onInteractOutside}
        onPointerDownOutside={blocked ? preventBlockedDismiss : onPointerDownOutside}
        {...props}
      />
    </PopoverPortal>
  );
});
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor, PopoverClose };
