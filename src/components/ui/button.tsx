import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 font-medium tracking-wide transition-[opacity,transform] duration-150 ease-[var(--ease-out)] active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40 select-none",
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-fg hover:opacity-90",
        ghost:
          "bg-transparent text-fg border border-border hover:bg-surface-2",
        quiet: "bg-surface-2 text-fg border border-border hover:opacity-90",
      },
      size: {
        sm: "h-9 px-3 text-xs rounded-xs min-w-9",
        md: "h-11 px-5 text-sm rounded-sm min-w-11",
        lg: "h-12 px-6 text-base rounded-md min-w-11",
        xl: "h-14 px-8 text-base rounded-lg min-w-11",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return (
    <button className={cn(buttonVariants({ variant, size }), className)} {...props} />
  );
}
