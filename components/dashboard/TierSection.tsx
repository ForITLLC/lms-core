import type { ReactNode } from "react";

// A11y wrapper for each tier on the dashboard. <section aria-labelledby> wires
// the title heading to assistive tech; count and "view all" sit on the same
// row so the learner can scan a tier without scrolling its body. Renders an
// empty-state slot when there are no items and a slot was provided; otherwise
// hides itself entirely (no silent whitespace).

interface TierSectionProps {
  id: string;
  title: string;
  subtitle?: string;
  count: number;
  viewAllHref?: string;
  viewAllLabel?: string;
  emptyState?: ReactNode;
  children?: ReactNode;
}

export function TierSection({
  id,
  title,
  subtitle,
  count,
  viewAllHref,
  viewAllLabel = "View all",
  emptyState,
  children,
}: TierSectionProps) {
  if (count === 0 && !emptyState) return null;
  const headingId = `${id}-heading`;
  return (
    <section aria-labelledby={headingId} className="mb-10">
      <header className="flex items-end justify-between gap-4 mb-4">
        <div>
          <h2
            id={headingId}
            className="text-xl md:text-2xl font-bold text-gray-900"
          >
            {title}
            {count > 0 ? (
              <span className="ml-2 text-base font-medium text-gray-500">
                ({count})
              </span>
            ) : null}
          </h2>
          {subtitle ? (
            <p className="text-sm text-gray-500 mt-0.5">{subtitle}</p>
          ) : null}
        </div>
        {viewAllHref ? (
          <a
            href={viewAllHref}
            className="text-sm font-semibold whitespace-nowrap hover:underline"
            style={{ color: "var(--brand-primary)" }}
          >
            {viewAllLabel} →
          </a>
        ) : null}
      </header>
      {count === 0 ? emptyState : children}
    </section>
  );
}
