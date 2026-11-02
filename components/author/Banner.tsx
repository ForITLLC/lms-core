import type { ReactNode } from "react";

export function Banner({ tone, children }: { tone: "warning" | "error" | "success"; children: ReactNode }) {
  const colors = {
    warning: "border-amber-300 bg-amber-50 text-amber-900",
    error: "border-rose-300 bg-rose-50 text-rose-900",
    success: "border-emerald-300 bg-emerald-50 text-emerald-900",
  }[tone];
  return (
    <div role={tone === "success" ? "status" : "alert"} className={`rounded-lg border px-4 py-3 text-sm ${colors}`}>
      {children}
    </div>
  );
}
