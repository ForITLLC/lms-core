import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { StatusBadge } from "@/components/ui/StatusBadge";

// Single primitive for every Required / Upcoming / Optional dashboard item.
// Visual chassis: white card + 4px left-border accent keyed off urgency,
// title row, meta footer, status badge. Accessible: the whole card is one
// link, status colors are paired with text labels (never color-alone).

export type TaskUrgency = "overdue" | "due-soon" | "upcoming" | "optional";

interface TaskCardProps {
  href: string;
  title: string;
  reason: string;
  meta?: string;
  urgency: TaskUrgency;
  statusText: string;
  progressPct?: number;
  action?: string;
}

const ACCENT: Record<TaskUrgency, string> = {
  overdue: "border-l-red-500",
  "due-soon": "border-l-amber-500",
  upcoming: "border-l-blue-500",
  optional: "border-l-gray-300",
};

const BADGE_VARIANT: Record<TaskUrgency, "error" | "warning" | "info" | "neutral"> = {
  overdue: "error",
  "due-soon": "warning",
  upcoming: "info",
  optional: "neutral",
};

export function TaskCard({
  href,
  title,
  reason,
  meta,
  urgency,
  statusText,
  progressPct,
  action,
}: TaskCardProps) {
  const showProgress = typeof progressPct === "number" && progressPct > 0;
  return (
    <Link
      href={href}
      prefetch={false}
      className="block group focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 rounded-2xl"
    >
      <Card
        variant="white"
        padding="md"
        className={`border-l-4 ${ACCENT[urgency]} transition-shadow group-hover:shadow-md`}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <h3
              className="font-semibold leading-tight"
              style={{ color: "var(--brand-primary)" }}
            >
              {title}
            </h3>
            <p className="text-sm text-gray-600 mt-1">{reason}</p>
            {meta ? (
              <p className="text-xs text-gray-500 mt-1">{meta}</p>
            ) : null}
          </div>
          <div className="shrink-0 flex flex-col items-end gap-1">
            <StatusBadge status={statusText} variant={BADGE_VARIANT[urgency]} size="sm" />
            {action ? (
              <span
                className="text-xs font-semibold mt-1"
                style={{ color: "var(--brand-primary)" }}
              >
                {action} →
              </span>
            ) : null}
          </div>
        </div>
        {showProgress ? (
          <div className="mt-3">
            <div
              className="h-1.5 w-full bg-gray-200 rounded-full overflow-hidden"
              role="progressbar"
              aria-valuenow={progressPct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${title} progress`}
            >
              <div
                className="h-full"
                style={{
                  width: `${progressPct}%`,
                  backgroundColor: "var(--brand-primary)",
                }}
              />
            </div>
            <p className="text-xs text-gray-500 mt-1">{progressPct}% complete</p>
          </div>
        ) : null}
      </Card>
    </Link>
  );
}
