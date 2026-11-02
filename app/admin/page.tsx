import type { FC, ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui/Card";
import ShellRaw from "@/components/Shell";
import { getSessionUser } from "@/lib/get-session";
import { isPlatformStaff } from "@/lib/auth/platform";
import { canReadRecords } from "@/lib/auth/records-permissions";
import { trainingRecordsEnabled } from "@/lib/records/switch";

const Shell = ShellRaw as unknown as FC<{ children?: ReactNode; title?: string }>;

export const dynamic = "force-dynamic";

interface AdminLink {
  href: string;
  title: string;
  description: string;
}

const SECTIONS: AdminLink[] = [
  {
    href: "/admin/dashboard",
    title: "Compliance dashboard",
    description:
      "Tenant-wide completion and certificate status, measured against the default curriculum. Export to CSV.",
  },
  {
    href: "/admin/courses",
    title: "Courses",
    description:
      "Every course: version history, per-learner progress, and the feedback learners have left.",
  },
  {
    href: "/admin/assignments",
    title: "Course assignments",
    description:
      "Assign specific courses to specific learners. Each assignment pins the course version.",
  },
  {
    href: "/admin/curriculum",
    title: "Curriculum management",
    description:
      "Define the default curriculum — which courses are mandatory and the order they appear in.",
  },
  {
    href: "/admin/catalogue",
    title: "Shared catalogue",
    description:
      "Subscribe to courses from the shared catalogue. Subscribed courses appear read-only for your learners.",
  },
  {
    href: "/admin/integrations",
    title: "Integrations",
    description:
      "Read-only LMS API for Claude (via an MCP gateway) and your own scripts. Mint and revoke per-user API keys.",
  },
];

// An author sees the admin home too; these are the tenant admin's alone.
const ADMIN_ONLY_SECTIONS: AdminLink[] = [
  {
    href: "/admin/ai",
    title: "AI settings",
    description:
      "Choose whether learners' written answers are marked first by AI. An instructor confirms or overrides every mark.",
  },
];

// Shown to an admin only where the tenant's training records are switched on.
const RECORDS_SECTION: AdminLink = {
  href: "/admin/records",
  title: "Training records",
  description:
    "Enter checks, OJT and other training by hand, correct a record with a reason, keep personnel details, and import paper records from CSV.",
};

const PLATFORM_SECTIONS = [
  {
    href: "/admin/tenants",
    title: "Tenants",
    description:
      "Tenant hostnames. Provision DNS + Azure binding for new tenants on `<slug>.learn.forit.io`.",
  },
];

export default async function AdminPage() {
  const session = await getSessionUser();
  if (!session) redirect("/api/auth/login?returnTo=/admin");
  if (session.role !== "admin" && session.role !== "author") {
    redirect("/dashboard");
  }
  const isAdmin = session.role === "admin";
  const recordsOn = canReadRecords(session.role) && !!session.tenantId && (await trainingRecordsEnabled(session.tenantId));
  const tenantSections = [...SECTIONS, ...(isAdmin ? ADMIN_ONLY_SECTIONS : []), ...(recordsOn ? [RECORDS_SECTION] : [])];
  const sections = (await isPlatformStaff(session)) ? [...tenantSections, ...PLATFORM_SECTIONS] : tenantSections;

  return (
    <Shell title="Admin">
      <p className="text-gray-700 mb-6 max-w-prose">
        Manage courses, assignments, and compliance for your tenant.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        {sections.map((s) => (
          <Link key={s.href} href={s.href} prefetch={false} className="block">
            <Card
              variant="white"
              padding="lg"
              className="h-full transition-shadow hover:shadow-md"
            >
              <div
                className="text-base font-semibold"
                style={{ color: "var(--brand-primary)" }}
              >
                {s.title}
              </div>
              <p className="mt-1 text-sm text-gray-600">{s.description}</p>
            </Card>
          </Link>
        ))}
      </div>
    </Shell>
  );
}
