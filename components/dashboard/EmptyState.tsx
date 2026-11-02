import type { ReactNode } from "react";
import { Card } from "@/components/ui/Card";
import { IconCircle } from "@/components/ui/IconCircle";

// Celebratory + onboarding empty-state variants for the dashboard. Used by
// app/dashboard/page.tsx when Required = 0 (and optionally Upcoming = 0) and
// when the tenant has zero courses published.

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  message: string;
  cta?: { label: string; href: string };
}

export function EmptyState({ icon, title, message, cta }: EmptyStateProps) {
  return (
    <Card variant="white" padding="lg" className="text-center">
      <div className="mx-auto mb-3 inline-block">
        <IconCircle size="lg">{icon}</IconCircle>
      </div>
      <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
      <p className="text-sm text-gray-600 mt-1 max-w-xl mx-auto">{message}</p>
      {cta ? (
        <a
          href={cta.href}
          className="mt-4 inline-block px-4 py-2 text-sm font-semibold rounded-md text-white"
          style={{ backgroundColor: "var(--brand-primary)" }}
        >
          {cta.label}
        </a>
      ) : null}
    </Card>
  );
}
