import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { usePortalContainer } from "@/components/ui/portal-container";

function Dialog(props: React.ComponentProps<typeof DialogPrimitive.Root>) {
  const { blocked } = usePortalContainer();
  return <DialogPrimitive.Root {...props} {...(blocked ? { modal: false } : {})} />;
}

const DialogTrigger = DialogPrimitive.Trigger;
const DialogClose = DialogPrimitive.Close;

function DialogPortal({ container, ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  const { container: contextContainer } = usePortalContainer();
  return <DialogPrimitive.Portal container={container ?? contextContainer ?? undefined} {...props} />;
}

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const KEYBOARD_GAP = 12; // 底边与键盘之间的呼吸空间 (px)

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, style, onEscapeKeyDown, onFocusOutside, onInteractOutside,
  onPointerDownOutside, ...props }, ref) => {
  const { blocked } = usePortalContainer();
  const [kbStyle, setKbStyle] = React.useState<React.CSSProperties | null>(null);
  const preventBlockedDismiss = React.useCallback((event: Event) => event.preventDefault(), []);

  React.useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const sync = () => {
      const kbHeight = window.innerHeight - vv.height;
      if (kbHeight > 100) {
        // 键盘弹出：底边贴近键盘顶部，留出呼吸空间
        setKbStyle({
          top: "auto",
          bottom: kbHeight + KEYBOARD_GAP,
          transform: "translateX(-50%)",
          maxHeight: vv.height - KEYBOARD_GAP * 2,
        });
      } else {
        setKbStyle(null);
      }
    };

    vv.addEventListener("resize", sync);
    // 初始也跑一次，处理 Dialog 打开时键盘已弹出的场景
    sync();
    return () => vv.removeEventListener("resize", sync);
  }, []);

  return (
    <DialogPortal>
      <DialogPrimitive.Close asChild>
        <DialogOverlay />
      </DialogPrimitive.Close>
      <DialogPrimitive.Content
        ref={ref}
        style={{
          top: "50%",
          ...style,
          ...(kbStyle ?? {}),
        }}
        className={cn(
          "fixed left-[50%] z-[101] grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border border-brand-100 bg-card p-6 shadow-brand duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:rounded-lg",
          kbStyle && "overflow-y-auto",
          className
        )}
        onEscapeKeyDown={blocked ? preventBlockedDismiss : onEscapeKeyDown}
        onFocusOutside={blocked ? preventBlockedDismiss : onFocusOutside}
        onInteractOutside={blocked ? preventBlockedDismiss : onInteractOutside}
        onPointerDownOutside={blocked ? preventBlockedDismiss : onPointerDownOutside}
        {...props}
      >
        {children}
        <DialogPrimitive.Close asChild>
          <Button
            variant="ghost"
            size="icon"
            className="absolute right-4 top-4"
            aria-label="Close"
          >
            <X />
          </Button>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPortal>
  );
});
DialogContent.displayName = DialogPrimitive.Content.displayName;

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-col space-y-1.5 text-center sm:text-left", className)}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2", className)}
      {...props}
    />
  );
}

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("text-lg font-semibold leading-none tracking-tight", className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
