import { Card } from "@/components/ui/Card";

// Three-stat hero strip above the tiers. Required pulses red when > 0,
// Upcoming amber, certificates neutral. One column < sm, three at md+.
// Pure server component — values come from getDashboardSummary.

interface KpiStripProps {
  requiredCount: number;
  upcomingCount: number;
  certificatesValid: number;
}

interface StatProps {
  label: string;
  value: number;
  accentClass: string;
  emphasize: boolean;
}

function Stat({ label, value, accentClass, emphasize }: StatProps) {
  return (
    <Card variant="white" padding="md" className={`border-l-4 ${accentClass}`}>
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p
        className={`mt-1 text-3xl font-bold ${
          emphasize ? "text-gray-900" : "text-gray-700"
        }`}
      >
        {value}
      </p>
    </Card>
  );
}

export function KpiStrip({
  requiredCount,
  upcomingCount,
  certificatesValid,
}: KpiStripProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-8">
      <Stat
        label="Required"
        value={requiredCount}
        accentClass="border-l-red-500"
        emphasize={requiredCount > 0}
      />
      <Stat
        label="Upcoming (60d)"
        value={upcomingCount}
        accentClass="border-l-amber-500"
        emphasize={upcomingCount > 0}
      />
      <Stat
        label="Certificates earned"
        value={certificatesValid}
        accentClass="border-l-emerald-500"
        emphasize={false}
      />
    </div>
  );
}
