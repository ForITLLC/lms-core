import type { CSSProperties, MouseEventHandler, ReactNode } from "react";
import Link from "next/link";

type Variant = "primary" | "secondary" | "outline" | "danger";
type Size = "sm" | "md" | "lg";

interface ButtonProps {
  variant?: Variant;
  size?: Size;
  href?: string;
  onClick?: MouseEventHandler<HTMLElement>;
  type?: "button" | "submit";
  disabled?: boolean;
  className?: string;
  children: ReactNode;
  target?: string;
  prefetch?: boolean;
}

const BASE =
  "inline-flex items-center justify-center font-semibold rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed";

const SIZES: Record<Size, string> = {
  sm: "px-3 py-1.5 text-sm",
  md: "px-4 py-2 text-sm",
  lg: "px-6 py-3 text-base",
};

// `primary` background comes from the tenant CSS variable so white-label
// theming stays correct — never a hardcoded brand color.
const VARIANTS: Record<Variant, string> = {
  primary: "text-white hover:opacity-90",
  secondary: "bg-gray-900 text-white hover:bg-gray-700",
  outline: "border border-gray-300 bg-white text-gray-800 hover:bg-gray-50",
  danger: "bg-rose-600 text-white hover:bg-rose-700",
};

export default function Button({
  variant = "primary",
  size = "md",
  href,
  onClick,
  type = "button",
  disabled,
  className,
  children,
  target,
  prefetch,
}: ButtonProps) {
  const classes = [BASE, SIZES[size], VARIANTS[variant], className]
    .filter(Boolean)
    .join(" ");
  const style: CSSProperties | undefined =
    variant === "primary"
      ? { backgroundColor: "var(--brand-primary)" }
      : undefined;

  if (href) {
    return (
      <Link
        href={href}
        onClick={onClick}
        className={classes}
        style={style}
        target={target}
        prefetch={prefetch}
      >
        {children}
      </Link>
    );
  }

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={classes}
      style={style}
    >
      {children}
    </button>
  );
}
