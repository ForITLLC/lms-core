import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/get-session";
import { resolveLearner } from "@/lib/db/progress";
import { listOverdueForTenant } from "@/lib/db/overdue";
import {
  listUpcomingForLearner,
  listOptionalForLearner,
  getDashboardSummary,
  type UpcomingItem,
  type OptionalItem,
} from "@/lib/db/dashboard";
import type { OverdueItem } from "@/lib/db/overdue";

// JSON feed for the tiered learner dashboard. The page itself server-renders
// directly from the same helpers (one round-trip on initial load) — this route
// exists for client-side refresh and any future native client. Stays GET-only
// to keep CSRF surface zero.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface DashboardResponse {
  greeting: string;
  email: string;
  summary: {
    requiredCount: number;
    upcomingCount: number;
    certificatesValid: number;
  };
  required: OverdueItem[];
  upcoming: UpcomingItem[];
  optional: OptionalItem[];
}

function firstName(name: string | undefined, email: string): string {
  const source = name?.trim() || email;
  return source.split(/[\s@]/)[0] ?? "there";
}

export async function GET(): Promise<NextResponse> {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }
  if (!session.tenantId) {
    return NextResponse.json(
      { error: "NO_TENANT", message: "Session not bound to a tenant" },
      { status: 409 },
    );
  }

  const learner = await resolveLearner(
    session.tenantId,
    session.email,
    session.name ?? session.email,
    session.azureOid,
  );

  const [allOverdue, upcoming, optional, summary] = await Promise.all([
    listOverdueForTenant(session.tenantId),
    listUpcomingForLearner(session.tenantId, learner.learnerId),
    listOptionalForLearner(session.tenantId, learner.learnerId),
    getDashboardSummary(session.tenantId, learner.learnerId),
  ]);

  const required = allOverdue
    .filter((it) => it.learnerId === learner.learnerId)
    .sort((a, b) => {
      const ad = a.dueDate?.getTime() ?? 0;
      const bd = b.dueDate?.getTime() ?? 0;
      return ad - bd;
    });

  const body: DashboardResponse = {
    greeting: firstName(session.name, session.email),
    email: session.email,
    summary,
    required,
    upcoming,
    optional,
  };

  return NextResponse.json(body);
}
