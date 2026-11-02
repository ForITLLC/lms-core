import Link from "next/link";
import { Card } from "@/components/ui/Card";

interface ComingSoonProps {
  title: string;
  description: string;
  designLink?: string;
}

export default function ComingSoon({ title, description, designLink }: ComingSoonProps) {
  return (
    <Card variant="white" padding="lg" className="text-center">
      <h2
        className="text-2xl font-semibold mb-3"
        style={{ color: "var(--brand-primary)" }}
      >
        {title}
      </h2>
      <p className="text-gray-700 max-w-prose mx-auto">{description}</p>
      {designLink && (
        <p className="mt-4 text-sm text-gray-500">
          Design reference:{" "}
          <code className="font-mono">{designLink}</code>
        </p>
      )}
      <div className="mt-6">
        <Link
          href="/dashboard"
          className="text-sm font-semibold hover:underline"
          style={{ color: "var(--brand-primary)" }}
        >
          ← Back to dashboard
        </Link>
      </div>
    </Card>
  );
}
