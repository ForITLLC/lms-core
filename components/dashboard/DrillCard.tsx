import Button from "@/components/Button";
import type { LearnerStatsRow, LatestSession } from "@/lib/db/drill";

interface DrillCardProps {
  stats: LearnerStatsRow;
  completedToday: boolean;
  latest: LatestSession | null;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white border border-gray-200 px-4 py-2 min-w-[5.5rem]">
      <p className="text-[11px] uppercase tracking-wide text-gray-500">{label}</p>
      <p className="text-lg font-bold text-gray-900 leading-tight">{value}</p>
    </div>
  );
}

// The first thing on the dashboard: today's drill, streak and points. Brand
// colour only via the tenant CSS variable, and only as a tint and an edge —
// body text stays dark on light so it reads on any tenant palette.
export function DrillCard({ stats, completedToday, latest }: DrillCardProps) {
  const inProgress = latest !== null && !latest.completed && latest.answered > 0 && !completedToday;
  const headline = completedToday
    ? "Today's drill is done — nice."
    : inProgress
      ? `${latest.answered} of ${latest.total} answered. Finish today's five.`
      : "Five questions. Two minutes. Keep your own reasoning sharp.";
  const cta = completedToday ? "See today's results" : inProgress ? "Continue today's drill" : "Start today's drill";

  return (
    <section
      aria-labelledby="drill-heading"
      className="mb-8 rounded-2xl border shadow-sm"
      style={{
        borderColor: "var(--brand-primary)",
        backgroundColor: "color-mix(in srgb, var(--brand-primary) 7%, white)",
      }}
    >
      <div className="p-5 sm:p-6 lg:p-7 flex flex-col gap-5 lg:flex-row lg:items-center lg:gap-8">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--brand-primary)" }}>
            Daily drill
          </p>
          <h2 id="drill-heading" className="mt-1 text-xl lg:text-2xl font-semibold text-gray-900">
            {headline}
          </h2>
          <p className="mt-1 text-sm lg:text-base text-gray-600 max-w-prose">
            GMAT-style reasoning plus recall from courses you have finished. Say how sure you are before you
            answer — points reward being right <em>and</em> knowing it.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 lg:gap-4 lg:flex-shrink-0">
          <Stat label="Streak" value={`${stats.currentStreak} 🔥`} />
          <Stat label="Points" value={String(stats.totalPoints)} />
          {stats.freezesAvailable > 0 ? <Stat label="Freezes" value={`${stats.freezesAvailable} ❄️`} /> : null}
          <Button
            href="/drill"
            size="lg"
            variant={completedToday ? "outline" : "primary"}
            className="w-full sm:w-auto"
          >
            {cta}
          </Button>
        </div>
      </div>
    </section>
  );
}
