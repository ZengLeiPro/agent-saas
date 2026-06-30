import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 disabled:shadow-none [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // 主 CTA：实色 + 品牌色光晕 + hover 阴影扩散 + active 回压，形成"可点按感"
        default:
          "bg-primary text-primary-foreground shadow-[0_1px_2px_rgba(46,86,225,0.18),0_4px_12px_-2px_rgba(46,86,225,0.22)] hover:bg-primary/95 hover:shadow-[0_2px_4px_rgba(46,86,225,0.22),0_8px_20px_-4px_rgba(46,86,225,0.32)] active:shadow-[0_1px_2px_rgba(46,86,225,0.18)] active:translate-y-px",
        destructive:
          "bg-destructive text-destructive-foreground shadow-[0_1px_2px_rgba(245,63,63,0.18),0_4px_12px_-2px_rgba(245,63,63,0.22)] hover:bg-destructive/95 hover:shadow-[0_2px_4px_rgba(245,63,63,0.24),0_8px_20px_-4px_rgba(245,63,63,0.32)] active:shadow-[0_1px_2px_rgba(245,63,63,0.18)] active:translate-y-px",
        outline:
          "border border-input bg-background hover:bg-accent hover:text-accent-foreground hover:border-primary/30",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
