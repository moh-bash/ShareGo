import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "subtle";
type Size = "sm" | "md" | "lg";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-accent text-canvas font-semibold hover:bg-accent-strong active:brightness-95 shadow-[0_6px_20px_-8px_var(--color-accent)]",
  secondary:
    "bg-surface-2 text-ink hover:bg-surface-3 border border-hairline",
  ghost: "text-ink-muted hover:text-ink hover:bg-surface-2",
  danger: "bg-negative/12 text-negative hover:bg-negative/20 border border-negative/25",
  subtle: "bg-surface-2/70 text-ink-muted hover:text-ink hover:bg-surface-3",
};

const SIZES: Record<Size, string> = {
  // Touch targets stay >= 44px tall on the "lg" sizes used for mobile actions.
  sm: "h-9 px-3 text-sm gap-1.5 rounded-lg",
  md: "h-11 px-4 text-sm gap-2 rounded-xl",
  lg: "h-13 px-5 text-base gap-2 rounded-xl",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  iconAfter?: ReactNode;
  block?: boolean;
}

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  iconAfter,
  block,
  className = "",
  children,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={[
        "focus-ring inline-flex items-center justify-center whitespace-nowrap transition-colors duration-150",
        "disabled:pointer-events-none disabled:opacity-45",
        VARIANTS[variant],
        SIZES[size],
        block ? "w-full" : "",
        className,
      ].join(" ")}
      {...props}
    >
      {icon ? <span className="[&>svg]:size-4.5 shrink-0">{icon}</span> : null}
      {children}
      {iconAfter ? <span className="[&>svg]:size-4.5 shrink-0">{iconAfter}</span> : null}
    </button>
  );
}
